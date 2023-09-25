import { Contract, providers, Signer, utils } from 'ethers';
import { zipObject } from 'lodash';
import synthetix from '@rout-horizon/testnet-contracts';
import PerpsV2MarketConsolidatedJson from '../contracts/PerpsV2MarketConsolidated.json';
import PythAbi from '../contracts/Pyth.json';
import { createLogger } from './logging';
import { Network } from './typed';

const logger = createLogger('Utils');

interface KeeperContracts {
  exchangeRates: Contract;
  marketManager: Contract;
  marketSettings: Contract;
  markets: Record<string, { contract: Contract; asset: string }>;
  pyth: { priceFeedIds: Record<string, string>; endpoint: string; contract: Contract };
}

// @see: https://docs.pyth.network/consume-data/evm
const PYTH_CONTRACT_ADDRESSES: Record<Network, string> = {
  [Network.OPT_GOERLI]: '0xd7308b14BF4008e7C7196eC35610B1427C5702EA',
  [Network.OPT]: '0x4D7E825f80bDf85e913E0DD2A2D54927e9dE1594',
};

export const networkToSynthetixNetworkName = (network: Network): string => {
  switch (network) {
    case Network.OPT:
      return 'mainnet';
    case Network.OPT_GOERLI:
      return 'testnet';
    default:
      throw new Error(`Unsupported Synthetix Network Name Mapping '${network}'`);
  }
};

const getSynthetixContractByName = (
  name: string,
  network: Network,
  provider: providers.BaseProvider
): Contract => {
  const snxNetwork = networkToSynthetixNetworkName(network);
  const abi = synthetix.getSource({ network: snxNetwork, contract: name }).abi;
  const address = synthetix.getTarget({ network: snxNetwork, contract: name }).address;

  logger.info(`Found ${name} contract at '${address}'`);
  return new Contract(address, abi, provider);
};

export const getPerpsContracts = async (
  network: Network,
  pythPriceServer: string,
  signer: Signer,
  provider: providers.BaseProvider
): Promise<KeeperContracts> => {
  const marketManager = getSynthetixContractByName('FuturesMarketManager', network, provider);
  const exchangeRates = getSynthetixContractByName('ExchangeRates', network, provider);
  const marketSettings = getSynthetixContractByName('PerpsV2MarketSettings', network, provider);
  const perpsV2ExchangeRates = getSynthetixContractByName('PerpsV2ExchangeRate', network, provider);

  logger.info('Fetching available perps markets...');
  const marketSummaries = await marketManager.allMarketSummaries();
  const markets: KeeperContracts['markets'] = marketSummaries.reduce(
    (
      acc: KeeperContracts['markets'],
      {
        proxied,
        market,
        marketKey,
        asset,
      }: { proxied: boolean; market: string; marketKey: string; asset: string }
    ) => {
      marketKey = utils.parseBytes32String(marketKey);
      if (proxied) {
        logger.info(`Found market: '${marketKey}' @ '${market}'`);
        acc[marketKey] = {
          contract: new Contract(market, PerpsV2MarketConsolidatedJson.abi, signer),
          asset: utils.parseBytes32String(asset),
        };
      } else {
        logger.info(`Skipping market (not proxied): '${marketKey} @ '${market}`);
      }
      return acc;
    },
    {}
  );

  logger.info('Fetching Pyth price feeds for kept markets...');
  const marketValues = Object.values(markets);
  const marketAssets = marketValues.map(({ asset }) => asset);
  const marketPriceFeedIds = await Promise.all(
    marketAssets.map(
      (asset): Promise<string> =>
        perpsV2ExchangeRates.offchainPriceFeedId(utils.formatBytes32String(asset))
    )
  );
  const priceFeedIds = zipObject(marketAssets, marketPriceFeedIds);
  Object.keys(priceFeedIds).forEach(asset => {
    logger.info(`Pyth price feedId: ${asset} @ '${priceFeedIds[asset]}'`);
  });

  logger.info(`Keeping ${marketValues.length}/${marketSummaries.length} markets`);
  const pyth = {
    endpoint: pythPriceServer,
    priceFeedIds,
    contract: new Contract(PYTH_CONTRACT_ADDRESSES[network], PythAbi, provider),
  };
  logger.info(`Configuring off-chain with server '${pythPriceServer}'`);

  return { exchangeRates, marketManager, marketSettings, markets, pyth };
};

const headers = { "Accept-Encoding": "zh-CN,zh;q=0.9", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.82 Safari/537.36" };


export const sendTG = async (text: string) : Promise<void> => {
  // const teleURL = `https://api.telegram.org/bot5303409425:AAEtJSpaMsN0L3Eg_23pVBwqPVymbLDFynk/sendMessage?chat_id=-733678471&text=${text}`
  // // const teleURL = `https://api.telegram.org/bot1970470794:AAEjUUhyd7rdYNrwJZ-uLIxtYuXI4GTIumQ/sendMessage?chat_id=-1001579413187&text=${text}`
  // // const teleURL = `https://api.telegram.org/bot1970470794:AAEjUUhyd7rdYNrwJZ-uLIxtYuXI4GTIumQ/sendMessage?chat_id=-1001565839518&text=${text}`
  // // fetch price
  // await fetch(teleURL, {
  //   method: 'GET',
  //   headers: headers
  // })
  //   .then(response => response.json())
  //   // .then(data => {
  //   //   console.log(data);
  //   // });

    let myPromise = new Promise(function(resolve, reject) {
      resolve("I telegram You !!");
    });
}

export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
