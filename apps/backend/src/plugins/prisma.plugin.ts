import { FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import fp from 'fastify-plugin';

// Étendre les types Fastify pour inclure Prisma
declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

const prismaPlugin: FastifyPluginAsync = async (server) => {
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

  // Connexion à la base de données
  await prisma.$connect();

  // Décorateur Fastify pour accéder à Prisma dans les routes
  server.decorate('prisma', prisma);

  // Fermeture de la connexion lors de l'arrêt du serveur
  server.addHook('onClose', async (server) => {
    await server.prisma.$disconnect();
  });
};

export default fp(prismaPlugin);
export { prismaPlugin };
