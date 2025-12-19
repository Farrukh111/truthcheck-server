module.exports = {
  apps: [
    {
      name: "truth-api",
      script: "./api_gateway.js",
      watch: false, // Не перезагружать при изменении файлов (важно для Windows)
      env: {
        PORT: 5000,
        NODE_ENV: "production"
      }
    },
    {
      name: "truth-worker",
      script: "./worker_entry.js",
      watch: false, // Не перезагружать
      instances: 2, // Два воркера для скорости
      exec_mode: "cluster"
    }
  ]
};