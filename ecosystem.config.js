// PM2 Config
module.exports = {
  apps: [
    {
      name: 'perps-keeper-mainnet',
      script: './build/src/index.js',
      args: 'run',
    },
    {
      name: 'perps-keeper-testnet',
      script: './build/src/index.js',
      args: 'run',
    },
  ],
};
