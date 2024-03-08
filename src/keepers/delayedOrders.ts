import { Block } from '@ethersproject/abstract-provider';
import { BigNumber, Contract, Event, providers, utils } from 'ethers';
import { Keeper } from '.';
import { DelayedOrder, PerpsEvent } from '../typed';
import { chunk } from 'lodash';
import { Metric, Metrics } from '../metrics';
import { delay, sendTG, parseTxnError } from '../utils';
import { SignerPool } from '../signerpool';
import { wei } from '@synthetixio/wei';


export class DelayedOrdersKeeper extends Keeper {
  // The index
  private orders: Record<string, DelayedOrder> = {};

  // An additional buffer added to minAge to avoid calling too early.
  //
  // Note: Since we don't use block.timestamp but rather Date.now, timestamps on-chain
  // may not be up to date as a result, executing a tiny bit too early (as seconds).
  private readonly MIN_AGE_BUFFER = 10;

  // An additional buffer added to maxAge to determine if an order is stale.
  private readonly MAX_AGE_BUFFER = 60 * 5; // 5mins (in seconds).

  readonly EVENTS_OF_INTEREST: PerpsEvent[] = [
    PerpsEvent.DelayedOrderSubmitted,
    PerpsEvent.DelayedOrderRemoved,
  ];

  constructor(
    market: Contract,
    private readonly exchangeRates: Contract,
    baseAsset: string,
    signerPool: SignerPool,
    provider: providers.BaseProvider,
    metrics: Metrics,
    network: string,
    private readonly maxExecAttempts: number
  ) {
    super('DelayedOrdersKeeper', market, baseAsset, signerPool, provider, metrics, network);
  }

  async updateIndex(events: Event[]): Promise<void> {
    if (!events.length) {
      return;
    }

    this.logger.info('Events available for index', { args: { n: events.length } });
    const blockCache: Record<number, Block> = {};
    for (const evt of events) {
      const { event, args, blockNumber } = evt;
      if (!args || args.isOffchain) {
        this.logger.debug('No args present or is off-chain, skipping', { args: { event } });
        continue;
      }

      const { account } = args;
      switch (event) {
        case PerpsEvent.DelayedOrderSubmitted: {
          const { targetRoundId, intentionTime, executableAtTime } = args;
          this.logger.info('New order submitted. Adding to index!', {
            args: { account, blockNumber },
          });

          // see: `delayedOffchainOrders`.
          let timestamp: number;
          if (!intentionTime) {
            try {
              if (!blockCache[blockNumber]) {
                blockCache[blockNumber] = await evt.getBlock();
              }
              timestamp = blockCache[blockNumber].timestamp;
            } catch (err) {
              this.logger.error(`Fetching block for evt failed '${evt.blockNumber}'`, err);
              sendTG(`Delayed-Order, Fetching block for evt failed '${evt.blockNumber}'`);
              timestamp = 0;
            }
          } else {
            timestamp = intentionTime.toNumber();
          }

          this.orders[account] = {
            targetRoundId: targetRoundId,
            executableAtTime: executableAtTime,
            account,
            intentionTime: timestamp,
            executionFailures: 0,
          };
          break;
        }
        case PerpsEvent.DelayedOrderRemoved: {
          this.logger.info('Order cancelled or executed. Removing from index', {
            args: { account, blockNumber },
          });
          delete this.orders[account];
          break;
        }
        default:
          this.logger.debug('No handler found for event', {
            args: { event, account, blockNumber },
          });
      }
    }
  }

  private async executeOrder(account: string): Promise<void> {
    // Cases:
    //
    // (A) Invokes execute
    //  - The order is ready to be executed and the market allows for it
    // (B) Invokes execute and fails after n attempts and discards
    //  - We think the order is ready to be executed but on-chain, it is not
    //  - The order missed execution window. It must be cancelled
    //  - The order missed execution window. Cancellation is failing (e.g. paused)
    //  - We think the order can be executed/cancelled but the order does not exist

    const order = this.orders[account];

    if (!order) {
      this.logger.info('Account does not have any tracked orders', { args: { account } });
      return;
    }

    if (order.executionFailures > this.maxExecAttempts) {
      this.logger.info('Order execution exceeded max attempts', {
        args: { account, attempts: order.executionFailures },
      });
      sendTG(`Delayed-Order, User ${account}, Order execution exceeded max attempts.`);
      delete this.orders[account];
      return;
    }

    // TODO: Remove DelayedOrders that cannot be executed (and only be cancelled).

    try {
      await this.signerPool.withSigner(
        async signer => {
          // Perform one last check on-chain to see if order actually exists.
          const order = await this.market.delayedOrders(account);
          if (order.sizeDelta.eq(0)) {
            this.logger.info('Order does not exist, avoiding execution', { args: { account } });
            delete this.orders[account];
            this.metrics.count(Metric.DELAYED_ORDER_ALREADY_EXECUTED, true);
            // await this.metrics.count(Metric.DELAYED_ORDER_ALREADY_EXECUTED, this.metricDimensions);
            return;
          } else {
            this.logger.info('Order found on-chain. Continuing...', { args: { account } });
          }

          this.logger.info('Executing delayed order...', { args: { account } });
          const market = this.market.connect(signer);
          const gasEstimation = await market.estimateGas.executeDelayedOrder(account);
          const gasLimit = wei(gasEstimation)
            .mul(1.2)
            .toBN();

          this.logger.info('Estimated gas with upped limits', {
            args: { account, estimation: gasEstimation.toString(), limit: gasLimit.toString() },
          });

          const tx = await market.executeDelayedOrder(account);
          this.logger.info('Submitted transaction, waiting for completion...', {
            args: { account, nonce: tx.nonce },
          });
          await this.waitTx(tx);
          delete this.orders[account];
        },
        { asset: this.baseAsset }
      );
      this.metrics.count(Metric.DELAYED_ORDER_EXECUTED, true);
      // await this.metrics.count(Metric.DELAYED_ORDER_EXECUTED, this.metricDimensions);
    } catch (err) {
      order.executionFailures += 1;
      this.metrics.count(Metric.KEEPER_ERROR, true);
      // await this.metrics.count(Metric.KEEPER_ERROR, this.metricDimensions);
      this.logger.error('Delayed order execution failed', {
        args: { executionFailures: order.executionFailures, account: order.account, err },
      });
      const parsedResponse = parseTxnError(err);
      sendTG(`Delayed-Order, User ${account}, Order execution failed. ${parsedResponse}`);
      this.logger.error((err as Error).stack);
    }
  }

  // private async getOffchainMinMaxAge(): Promise<{
  //   minAge: ethers.BigNumber;
  //   maxAge: ethers.BigNumber;
  // }> {
  //   const bytes32BaseAsset = utils.formatBytes32String(this.marketKey);

  //   this.logger.debug('Fetching min/max ages', { args: { marketKey: this.marketKey } });
  //   const minAge = await this.marketSettings.minDelayTimeDelta(bytes32BaseAsset);
  //   const maxAge = await this.marketSettings.maxDelayTimeDelta(bytes32BaseAsset);

  //   this.logger.info('Found off-chain order min/max age', {
  //     args: { minAge, maxAge, marketKey: this.marketKey },
  //   });
  //   return { minAge, maxAge };
  // }

  async execute(): Promise<void> {
    try {
      const orders = Object.values(this.orders);

      if (orders.length === 0) {
        this.logger.info('No delayed orders available... skipping');
        return;
      }

      // Get the latest CL roundId.
      const currentRoundId = await this.exchangeRates.getCurrentRoundId(
        utils.formatBytes32String(this.baseAsset)
      );

      const block = await this.provider.getBlock(await this.provider.getBlockNumber());

      // Filter out orders that may be ready to execute.
      const executableOrders = orders.filter(
        ({ executableAtTime, targetRoundId }) =>
          currentRoundId.gte(targetRoundId) || BigNumber.from(block.timestamp).gte(executableAtTime)
      );

      // No orders. Move on.
      if (executableOrders.length === 0) {
        this.logger.info('No delayed orders ready... skipping', {
          args: { pendingOrders: orders.length },
        });
        return;
      }

      this.logger.info(
        `Found ${executableOrders.length}/${orders.length} order(s) that can be executed`
      );

      for (const batch of chunk(executableOrders, this.MAX_BATCH_SIZE)) {
        this.logger.info(`Running keeper batch with '${batch.length}' orders(s) to keep`);
        const batches = batch.map(({ account }) =>
          this.execAsyncKeeperCallback(account, () => this.executeOrder(account))
        );
        await Promise.all(batches);
        await delay(this.BATCH_WAIT_TIME);
      }
    } catch (err) {
      this.logger.error('Failed to execute delayed order', { args: { err } });
      this.logger.error((err as Error).stack);
    }
  }
}