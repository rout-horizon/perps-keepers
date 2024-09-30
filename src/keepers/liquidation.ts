import { TransactionResponse } from '@ethersproject/abstract-provider';
import { wei } from '@synthetixio/wei';
import { BigNumber, Contract, Event, providers, utils } from 'ethers';
import { chunk, flatten } from 'lodash';
import { Keeper } from '.';
import { UNIT } from './helpers';
import { PerpsEvent, Position } from '../typed';
import { Metric, Metrics } from '../metrics';
import { delay, sendTG, parseTxnError } from '../utils';
import { SignerPool } from '../signerpool';
import { MULTICALL_ABI } from '../abi/Multicall3';

export class LiquidationKeeper extends Keeper {
  // Required for sorting position by proximity of liquidation price to current price
  private assetPrice: number = 0;

  // The index
  private positions: Record<string, Position> = {};
  private blockTipTimestamp: number = 0;

  readonly EVENTS_OF_INTEREST: PerpsEvent[] = [
    PerpsEvent.FundingRecomputed,
    PerpsEvent.PositionLiquidated,
    PerpsEvent.PositionModified,
    PerpsEvent.PositionFlagged,
  ];

  constructor(
    market: Contract,
    baseAsset: string,
    signerPool: SignerPool,
    provider: providers.BaseProvider,
    metrics: Metrics,
    network: string
  ) {
    super('LiquidationKeeper', market, baseAsset, signerPool, provider, metrics, network);
  }

  async updateIndex(events: Event[], block?: providers.Block, assetPrice?: number): Promise<void> {
    if (block) {
      // Set block timestamp here in case there were no events to update the timestamp from.
      this.blockTipTimestamp = block.timestamp;
    }

    if (assetPrice) {
      // Necessary to determine if the notional value of positions is underwater.
      this.assetPrice = assetPrice;
    }

    if (!events.length) {
      return;
    }

    this.logger.info('Events available for index', { args: { n: events.length } });
    events.forEach(({ event, args, blockNumber }) => {
      if (!args) {
        return;
      }
      switch (event) {
        case PerpsEvent.FundingRecomputed: {
          // just a sneaky way to get timestamps without making awaiting getBlock() calls
          // keeping track of time is needed for the volume metrics during the initial
          // sync so that we don't have to await getting block timestamp for each new block
          this.blockTipTimestamp = args.timestamp.toNumber();
          return;
        }
        case PerpsEvent.PositionModified: {
          const { id, account, size, margin, lastPrice } = args;
          if (margin.eq(BigNumber.from(0))) {
            // Position has been closed.
            delete this.positions[account];
            return;
          }
          this.positions[account] = {
            id,
            account,
            size: wei(size)
              .div(UNIT)
              .toNumber(),
            leverage: wei(size)
              .abs()
              .mul(lastPrice)
              .div(margin)
              .div(UNIT)
              .toNumber(),
            liqPrice: -1, // will be updated by keeper routine
            liqPriceUpdatedTimestamp: 0,
          };
          return;
        }
        case PerpsEvent.PositionLiquidated: {
          delete this.positions[args.account];
          return;
        }
        case PerpsEvent.PositionFlagged: {
          delete this.positions[args.account];
          return;
        }
        default:
          this.logger.debug('No handler found for event', {
            args: { event, blockNumber },
          });
      }
    });
  }

  hydrateIndex(positions: Position[], block: providers.Block) {
    this.logger.debug('hydrating index from data on-chain', {
      args: {
        n: positions.length,
      },
    });

    const prevPositionsLength = Object.keys(this.positions).length;
    const newPositions: Record<string, Position> = {};

    for (const position of positions) {
      // ...order first because we want to override any default settings with existing values so that
      // they can be persisted between hydration (e.g. status).
      newPositions[position.account] = { ...position, ...this.positions[position.account] };
    }
    this.positions = newPositions;
    this.blockTipTimestamp = block.timestamp;

    const currPositionsLength = Object.keys(this.positions).length;
    if (prevPositionsLength !== currPositionsLength) {
      this.logger.info('Orders change detected', {
        args: {
          delta: currPositionsLength - prevPositionsLength,
          n: currPositionsLength,
        },
      });
    }
  }

  private liquidationGroups(
    posArr: Position[],
    priceProximityThreshold = 0.05,
    maxFarPricesToUpdate = 1, // max number of older liquidation prices to update
    farPriceRecencyCutoff = 6 * 3600 // interval during which the liquidation price is considered up to date if it's far
  ) {
    // group
    const knownLiqPrice = posArr.filter(p => p.liqPrice !== -1);
    const unknownLiqPrice = posArr.filter(p => p.liqPrice === -1);

    const liqPriceClose = knownLiqPrice.filter(
      p => Math.abs(p.liqPrice - this.assetPrice) / this.assetPrice <= priceProximityThreshold
    );
    const liqPriceFar = knownLiqPrice.filter(
      p => Math.abs(p.liqPrice - this.assetPrice) / this.assetPrice > priceProximityThreshold
    );

    // sort close prices by liquidation price and leverage
    liqPriceClose.sort(
      (p1, p2) =>
        // sort by ascending proximity of liquidation price to current price
        Math.abs(p1.liqPrice - this.assetPrice) - Math.abs(p2.liqPrice - this.assetPrice) ||
        // if liq price is the same, sort by descending leverage (which should be different)
        p2.leverage - p1.leverage // desc)
    );

    // sort unknown liq prices by leverage
    unknownLiqPrice.sort((p1, p2) => p2.leverage - p1.leverage); //desc

    const outdatedLiqPrices = liqPriceFar.filter(
      p => p.liqPriceUpdatedTimestamp < this.blockTipTimestamp - farPriceRecencyCutoff
    );
    // sort far liquidation prices by how out of date they are
    // this should constantly update old positions' liq price
    outdatedLiqPrices.sort((p1, p2) => p1.liqPriceUpdatedTimestamp - p2.liqPriceUpdatedTimestamp); //asc

    // first known close prices, then unknown prices yet
    return [
      liqPriceClose, // all close prices within threshold
      unknownLiqPrice, // all unknown liq prices (to get them updated)
      outdatedLiqPrices.slice(0, maxFarPricesToUpdate), // some max number of of outdated prices to reduce spamming the node and prevent self DOS when there are many positions
    ];
  }

  private async liquidatePosition(account: string) {
    try {
      // Create a public rpc signer as quicknode rpc behaves wierd 
      const publicRpcProvider = new providers.JsonRpcProvider('https://data-seed-prebsc-1-s1.binance.org:8545/');

      this.logger.debug('Checking if can liquidate', { args: { account } });
      const canLiquidateOrder = await this.market.canLiquidate(account);
      const isFlaggedOrder = await this.market.isFlagged(account);

      if (!canLiquidateOrder && !isFlaggedOrder) {
        // if it's not liquidatable update it's liquidation price
        this.positions[account].liqPrice = parseFloat(
          utils.formatUnits((await this.market.liquidationPrice(account)).price)
        );
        this.positions[account].liqPriceUpdatedTimestamp = this.blockTipTimestamp;
        this.logger.info('Cannot liquidate position', {
          args: { account, liqPrice: this.positions[account].liqPrice },
        });
        return;
      }
      else {
        // Liquidate directly
        if (isFlaggedOrder) {
          await this.signerPool
            .withSigner(
              async signer => {
                const market = this.market.connect(signer);
                this.logger.info('Liquidating position...', { args: { account } });

                // Estimate Gas
                const gasEstimation = await market.estimateGas.liquidatePosition(account);

                const gasLimit = wei(gasEstimation)
                  .mul(1.2)   // Increase a little bit
                  .toBN();

                let gasPrice = await this.provider.getGasPrice()       // in v5 - we use getGasPrice
                console.log('*************** Liquidation Keeper LiquidatePosition GasPrice**************', gasPrice.toString());
                gasPrice = gasPrice.mul(2) // Increase a little bit

                const gasOptions = {
                  gasLimit: gasLimit,
                  gasPrice: gasPrice
                }

                const liquidateTx: TransactionResponse = await market
                  .connect(signer)
                  // .connect(signer.connect(publicRpcProvider))
                  .liquidatePosition(account, gasOptions);
                this.logger.info('Submitted transaction, waiting for completion...', {
                  args: { account, nonce: liquidateTx.nonce },
                });
                await this.waitTx(liquidateTx);
                this.metrics.count(Metric.POSITION_LIQUIDATED, true);
                // await this.metrics.count(Metric.POSITION_LIQUIDATED, this.metricDimensions);
              },
              { asset: this.baseAsset }
            )
            .catch(err => {
              this.logger.error('Failed while flagging position....', {
                args: { account: account, error: err },
              });
              const parsedResponse = parseTxnError(err);
              sendTG(`Liquidation-Order, User ${account}, Failed while flagging position.... ${parsedResponse}`);
              this.logger.error((err as Error).stack);
            });
        }
        // Flag and Liquidate
        else {
          await this.signerPool
            .withSigner(
              async signer => {
                const market = this.market.connect(signer);
                this.logger.info('Flagging position...', { args: { account } });

                // Estimate Gas
                const gasEstimation = await market.estimateGas.flagPosition(account);

                const gasLimit = wei(gasEstimation)
                  .mul(1.2)   // Increase a little bit
                  .toBN();

                let gasPrice = await this.provider.getGasPrice()       // in v5 - we use getGasPrice
                console.log('*************** Liquidation Keeper FlagPosition GasPrice**************', gasPrice.toString());
                gasPrice = gasPrice.mul(2) // Increase a little bit

                const gasOptions = {
                  gasLimit: gasLimit,
                  gasPrice: gasPrice
                }

                const flagTx: TransactionResponse = await market
                  .connect(signer)
                  // .connect(signer.connect(publicRpcProvider))
                  .flagPosition(account, gasOptions);
                this.logger.info('Submitted transaction, waiting for completion...', {
                  args: { account, nonce: flagTx.nonce },
                });
                await this.waitTx(flagTx);

                this.logger.info('Liquidating position...', { args: { account } });
                const liquidateTx: TransactionResponse = await market
                  .connect(signer)
                  // .connect(signer.connect(publicRpcProvider))
                  .liquidatePosition(account);
                this.logger.info('Submitted transaction, waiting for completion...', {
                  args: { account, nonce: liquidateTx.nonce },
                });
                await this.waitTx(liquidateTx);
                this.metrics.count(Metric.POSITION_LIQUIDATED, true);
                // await this.metrics.count(Metric.POSITION_LIQUIDATED, this.metricDimensions);
              },
              { asset: this.baseAsset }
            )
            .catch(err => {
              this.logger.error('Failed while liquidating position....', {
                args: { account: account, error: err },
              });
              sendTG(`Liquidation-Order, User ${account}, Failed while liquidating position.... Please process soon ${(err as Error).message}`);

              this.logger.error((err as Error).stack);
            });
        }
      }
    } catch (err) {
      this.metrics.count(Metric.KEEPER_ERROR, true);
      // await this.metrics.count(Metric.KEEPER_ERROR,this.metricDimensions);
      throw err;
    }
  }

  async execute(): Promise<void> {
    try {
      // @see: https://www.multicall3.com/deployments
      const rpcprovider = new providers.JsonRpcProvider(process.env.PROVIDER_URL_INFURA);
        // "https://sly-solitary-aura.arbitrum-sepolia.quiknode.pro/80e7211daaac0ba78007cdd7329ed52274d98322/");

      const multicall = new Contract(
        '0xcA11bde05977b3631167028862bE2a173976CA11',
        MULTICALL_ABI,
        rpcprovider
      );
      // Grab all open positions.
      const openPositions = Object.values(this.positions).filter(p => Math.abs(p.size) > 0);
      this.logger.info('Active open positions  while liquidating position....', {
        args: { openPositions: openPositions.length },
      });


      if (openPositions.length > 0) {
        const pageSize = 20 // MULTICALL_PAGE_SIZE;

        // Array to store promises for each callStatic result
        const staticCallPromises: Promise<any>[] = [];

        // Paginate the orders
        for (let i = 0; i < openPositions.length; i += pageSize) {
          const paginatedOrders = openPositions.slice(i, i + pageSize);

          const staticCalls = paginatedOrders.map(order => {
            return {
              target: this.market.address,
              callData: this.market.interface.encodeFunctionData("flagPosition", [order.account]),
              allowFailure: true,
            }
          })

          // Add the static call to the promises array
          staticCallPromises.push(multicall.callStatic.aggregate3(staticCalls));
        }

        type STATIC_CALL_RESULT = {
          success: boolean,
          returnData: string,
        }

        // Execute all static calls in parallel and accumulate results
        const staticResultsArray: STATIC_CALL_RESULT[][] = await Promise.all(staticCallPromises);

        let successfulPositions: Position[] = [];

        // Filter positions that can be flagged
        staticResultsArray.forEach((staticResults: STATIC_CALL_RESULT[], index) => {
          const paginatedOrders = openPositions.slice(index * pageSize, (index + 1) * pageSize);
          const successfulPagePositions = paginatedOrders.filter((_, i) => staticResults[i].success);
          successfulPositions = successfulPositions.concat(successfulPagePositions);
        });

        this.logger.info(`Ready to execute: ${successfulPositions.length}`);
        if (successfulPositions.length > 0) {
          // Create the actual execution payload
          const executeCalls = successfulPositions.slice(0, pageSize).map(order => {
            return {
              target: this.market.address,
              callData: this.market.interface.encodeFunctionData("flagPosition", [order.account]),
              allowFailure: true,
            }
          });

          await this.signerPool
            .withSigner(
              async signer => {
                // const market = multicall.connect(signer);
                // this.logger.info('Flagging position...', { args: { account } });

                // Estimate Gas
                // const gasEstimation = await market.estimateGas.flagPosition(account);
                const gasEstimation = await multicall.estimateGas.aggregate3(executeCalls);


                const gasLimit = wei(gasEstimation)
                  .mul(1.2)   // Increase a little bit
                  .toBN();

                let gasPrice = await this.provider.getGasPrice()       // in v5 - we use getGasPrice
                console.log('*************** Liquidation Keeper FlagPosition GasPrice**************', gasPrice.toString());
                gasPrice = gasPrice.mul(2) // Increase a little bit

                const gasOptions = {
                  gasLimit: gasLimit,
                  gasPrice: gasPrice
                }

                const flagTx: TransactionResponse = await multicall
                  .connect(signer)
                  .aggregate3(executeCalls, gasOptions);

                // const flagTx: TransactionResponse = await market
                //   .connect(signer)
                //   // .connect(signer.connect(publicRpcProvider))
                //   .flagPosition(account, gasOptions);
                this.logger.info('Submitted transaction, waiting for completion...', {
                  args: { nonce: flagTx.nonce },
                });
                await this.waitTx(flagTx);

                // this.logger.info('Liquidating position...', { args: { nonce: flagTx.nonce } });
                // const liquidateTx: TransactionResponse = await multicall
                //   .connect(signer)
                //   // .connect(signer.connect(publicRpcProvider))
                //   .liquidatePosition(account);
                // this.logger.info('Submitted transaction, waiting for completion...', {
                //   args: { account, nonce: liquidateTx.nonce },
                // });
                // await this.waitTx(liquidateTx);
                // this.metrics.count(Metric.POSITION_LIQUIDATED, true);
                // await this.metrics.count(Metric.POSITION_LIQUIDATED, this.metricDimensions);
              },
              { asset: this.baseAsset }
            )
            .catch(err => {
              this.logger.error('Failed while liquidating position....', {
                args: { error: err },
              });
              // sendTG(`Liquidation-Order, User ${account}, Failed while liquidating position.... Please process soon ${(err as Error).message}`);

              this.logger.error((err as Error).stack);
            });
        }
      }
      else return;

    } catch (err) {
      this.logger.error('Failed to execute liquidations', { args: { err } });
      sendTG(`Liquidation Keeper Failed, Failed to execute liquidations Please process soon ${(err as Error).message}`);
      this.logger.error((err as Error).stack);
    }
  }
}
