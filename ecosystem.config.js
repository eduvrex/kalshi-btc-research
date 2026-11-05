module.exports = {
  apps: [
    {
      name: 'collector-kalshi',
      script: 'src/collectors/collector-kalshi.js',
      cwd: __dirname,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '300M',
      out_file: 'logs/collector-kalshi.out.log',
      error_file: 'logs/collector-kalshi.err.log',
      merge_logs: true,
      time: true
    },
    {
      name: 'dislocation-monitor',
      script: 'src/research/live-dislocation-monitor.js',
      cwd: __dirname,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '200M',
      out_file: 'logs/dislocation-monitor.out.log',
      error_file: 'logs/dislocation-monitor.err.log',
      merge_logs: true,
      time: true
    },
    {
      name: 'collector-prices',
      script: 'src/collectors/collector-prices.js',
      cwd: __dirname,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '300M',
      out_file: 'logs/collector-prices.out.log',
      error_file: 'logs/collector-prices.err.log',
      merge_logs: true,
      time: true
    }
  ]
};
