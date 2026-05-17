const { createDatabase } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);

async function start() {
  const db = createDatabase();
  await db.init();

  const app = createApp({ db });
  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`TimeChek running at http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
