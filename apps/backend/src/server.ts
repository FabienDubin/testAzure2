import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwtPlugin from './plugins/jwt.plugin';
import prismaPlugin from './plugins/prisma.plugin';
import authRoutes from './routes/auth.route';
import providersRoutes from './routes/providers.route';
import providerTypesRoutes from './routes/provider-types.route';

const server = Fastify({
  logger: {
    transport:
      process.env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  },
});

// Fonction principale pour démarrer le serveur
async function start() {
  try {
    // Plugins
    await server.register(cors, {
      origin: process.env.CORS_ORIGIN || '*',
    });

    await server.register(jwtPlugin);
    await server.register(prismaPlugin);

    // Routes
    server.get('/health', async () => {
      return { status: 'ok', timestamp: new Date().toISOString() };
    });

    await server.register(authRoutes, { prefix: '/api/auth' });
    await server.register(providersRoutes, { prefix: '/api/providers' });
    await server.register(providerTypesRoutes, { prefix: '/api/provider-types' });

    // Démarrage du serveur
    const port = Number(process.env.PORT) || 3001;
    const host = process.env.HOST || '0.0.0.0'; // Important pour Azure

    await server.listen({ port, host });
    console.log(`🚀 Server ready at http://${host}:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Gestion de l'arrêt gracieux
const shutdown = async () => {
  try {
    await server.close();
    console.log('Server closed gracefully');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Démarrage
start();
