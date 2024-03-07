module.exports = {
  apps: [
    {
      name: 'perps-keeper-mainnet',
      cron_restart: '0 */5 * * *',
      max_memory_restart: '1000M',
      script: './build/index.js',
      args: 'run',
      time: true
    },
    {
      name: 'perps-keeper-testnet',
      cron_restart: '0 */5 * * *',
      max_memory_restart: '1000M',
      script: './build/index.js',
      args: 'run',
      time: true
    },
  ],
};
