module.exports = {
  apps: [
    {
      name: 'cams-backend',
      script: 'npm',           // same as: pm2 start npm -- run start
      args: 'run start',
      cwd: '/var/www/CAMS_Backend',

      env: {
        NODE_ENV: 'development',
      },

      env_production: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://doadmin:AVNS_F0yL__QCyCLYjZcluIF@db-postgresql-nyc3-4198>
      },
    },
  ],
};
