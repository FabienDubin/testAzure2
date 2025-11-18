# POC Azure - Monorepo Test

POC pour valider l'architecture et le déploiement d'une application full-stack sur Azure.

## 🏗️ Architecture

```
TestAzure2/
├── apps/
│   ├── frontend/        # Next.js 16 - Azure Static Web App
│   └── backend/         # Fastify - Azure Web App
├── packages/
│   └── shared/          # Schémas Zod + Types - Azure Artifacts
└── .github/
    └── workflows/       # GitHub Actions pour CI/CD
```

## 🛠️ Stack Technique

- **Frontend**: Next.js 16 (hybride/standalone) → Azure Static Web Apps
- **Backend**: Fastify + Prisma → Azure Web App (Node.js)
- **Package partagé**: TypeScript + Zod → Azure Artifacts
- **Base de données**: PostgreSQL (local + Azure)
- **CI/CD**: GitHub Actions
- **Gestionnaire de paquets**: NPM (sans workspaces)

## 🚀 Installation

### Prérequis
- Node.js 18+
- NPM
- PostgreSQL (local)
- Compte Azure

### Setup local

1. **Cloner le projet**
   ```bash
   git clone <repo-url>
   cd TestAzure2
   ```

2. **Installer le package shared**
   ```bash
   cd packages/shared
   npm install
   npm run build
   cd ../..
   ```

3. **Backend**
   ```bash
   cd apps/backend
   npm install
   # Configurer .env (voir apps/backend/.env.example)
   npx prisma generate
   npx prisma migrate dev
   npm run dev
   ```

4. **Frontend**
   ```bash
   cd apps/frontend
   npm install
   # Configurer .env.local (voir apps/frontend/.env.example)
   npm run dev
   ```

## 📦 Déploiement Azure

Voir la documentation détaillée dans chaque dossier :
- `apps/frontend/README.md` - Déploiement Static Web App
- `apps/backend/README.md` - Déploiement Web App
- `packages/shared/README.md` - Publication sur Azure Artifacts

## 🔐 Variables d'environnement

### Backend
- `DATABASE_URL` - URL de connexion PostgreSQL
- `PORT` - Port du serveur (défaut: 3001)
- `NODE_ENV` - Environment (development/production)

### Frontend
- `NEXT_PUBLIC_API_URL` - URL de l'API backend

## 📝 Scripts

Chaque projet a ses propres scripts. Voir les `package.json` respectifs.

## 🤝 Contribution

Ce projet est un POC pour validation d'architecture.
