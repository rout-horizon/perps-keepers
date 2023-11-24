import io = require("@pm2/io");
import { camelCase, upperFirst } from 'lodash';
import winston from 'winston';
import { createLogger } from './logging';
import { Network } from './typed';
import Gauge from '@pm2/io/build/main/utils/metrics/gauge';
import Counter from '@pm2/io/build/main/utils/metrics/counter';

export enum Metric {
  // How long this keeper has been up and executing.
  KEEPER_UPTIME = 'KeeperUpTime',

  // Amount of ETH in the keeper address.
  KEEPER_SIGNER_ETH_BALANCE = 'KeeperSignerEthBalance',

  // A metric sent upon startup (useful to track freq of crash & restarts).
  KEEPER_STARTUP = 'KeeperStartUp',

  // When any error (liquidation or order execution) occurs.
  KEEPER_ERROR = 'KeeperError',

  // TODO: Consider tracking open promises

  // Number of blocks since the last time the distributor has index/processed blocks.
  DISTRIBUTOR_BLOCK_DELTA = 'DistributorBlockDelta',

  // Time in ms it takes to process blocks per iteration at the distributor.
  DISTRIBUTOR_BLOCK_PROCESS_TIME = 'DistributorBlockProcessTime',

  // Delayed order executed successfully.
  DELAYED_ORDER_EXECUTED = 'DelayedOrderExecuted',

  // Delayed order executed mid-processing (includes off/on chain).
  DELAYED_ORDER_ALREADY_EXECUTED = 'DelayedOrderAlreadyExecuted',

  // Offchain order executed successfully.
  OFFCHAIN_ORDER_EXECUTED = 'OffchainOrderExecuted',

  // Open position liquidated successfully.
  POSITION_LIQUIDATED = 'PositionLiquidated',

  // Number of available signers in the signer pool (0 means transactions cannot be executed).
  SIGNER_POOL_SIZE = 'SignerPoolSize',

  // TODO: Add metrics for time taken per keeper type.
}

export class Metrics {
  private readonly BASE_NAMESPACE = 'PerpsV2Keeper/';
  // private readonly DEFAULT_RESOLUTION = 60; // 60s

  private readonly namespace: string;

  private constructor(
      readonly isEnabled: boolean,
      network: Network,
      private readonly logger: winston.Logger,
  ) {
      // e.g. `mainnet-ovm` = PerpsV2Keeper/MainnetOvm
      this.namespace = `${this.BASE_NAMESPACE}${upperFirst(camelCase(network))}`;
  }

  static create(isEnabled: boolean, network: Network): Metrics {
      const logger = createLogger('Metrics');
      logger.info('Initialising metrics', { args: { enabled: isEnabled } });
      return new Metrics(
          isEnabled,
          network,
          logger
      );
  }

  /* Gauge/count metrics*/
  gauge(
      name: Metric,
      value: number,
      unit: string,
  ): void {
      if (!this.isEnabled) {
          this.logger.debug('Send no-op due to missing CW client', {
              args: { enabled: this.isEnabled, namespace: this.namespace },
          });
          return;
      }

      try {
          const metricName: Gauge = io.metric({
              name: name,
              unit: unit,
          })
          metricName.set(value);
      } catch (err) {
          // no-op the metric failure. Monitoring should not impact the normal behaviour of the application.
          this.logger.error('Failed to send metrics to PM2', { args: { err } });
      }
  }

  /* Counter metrics*/
  count(name: Metric, increment: boolean): void {
      try {
          const metricName: Counter = io.counter({
              name: name,
          })
          if (!increment) metricName.dec()
          metricName.inc();

      } catch (err) {
          // no-op the metric failure. Monitoring should not impact the normal behaviour of the application.
          this.logger.error('Failed to send metrics to PM2', { args: { err } });
      }
  }
}