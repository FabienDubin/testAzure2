# Documentation DevOps - Monorepo Azure sans Workspaces

Ce document décrit l'architecture DevOps complète du projet, du package shared au backend, avec tous les détails pour reproduire cette stack.

## Table des matières

1. [Architecture générale](#architecture-générale)
2. [Package Shared - Azure Artifacts](#package-shared---azure-artifacts)
3. [Backend - Azure Web App](#backend---azure-web-app)
4. [Prisma sur Azure - Particularités](#prisma-sur-azure---particularités)
5. [Frontend - Azure Static Web Apps](#frontend---azure-static-web-apps)
6. [Troubleshooting](#troubleshooting)

---

## Architecture générale

### Structure du projet

```
TestAzure2/
├── apps/
│   ├── backend/           # API Fastify
│   └── frontend/          # Next.js 16
├── packages/
│   └── shared/            # Package npm privé (Zod schemas + types)
└── .github/workflows/     # CI/CD GitHub Actions
```

### Choix architectural : Pas de npm workspaces

**⚠️ IMPORTANT** : Nous n'utilisons PAS `npm workspaces` même si c'est un monorepo.

**Pourquoi ?**
- Azure Web App et Azure Static Web Apps gèrent mal les workspaces
- Chaque app doit être **indépendante** avec son propre `package.json` et `node_modules`
- Simplifie le déploiement : chaque workflow GitHub Actions ne gère qu'une seule app

**Comment ?**
- Pas de `package.json` à la racine
- Chaque app a son propre `package.json` complet
- Le package `shared` est publié sur Azure Artifacts comme un package npm normal
- Les apps consomment `shared` via `npm install @mcigroupfrance/shared`

---

## Package Shared - Azure Artifacts

### 1. Structure du package

```
packages/shared/
├── src/
│   ├── index.ts              # Point d'entrée : exporte tout
│   ├── schemas/              # Schémas Zod pour validation
│   │   ├── auth.schema.ts
│   │   ├── providers.schema.ts
│   │   └── provider-types.schema.ts
│   └── types/                # Types TypeScript
│       ├── auth.types.ts
│       ├── providers.types.ts
│       └── provider-types.types.ts
├── package.json
├── tsconfig.json
├── .npmrc                    # Configuration Azure Artifacts
└── .npmignore                # Fichiers à exclure du package
```

### 2. Configuration package.json

```json
{
  "name": "@mcigroupfrance/shared",
  "version": "1.0.X",
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.6.0"
  }
}
```

**Points clés :**
- **`exports`** : L'ordre est important ! `types` en premier pour éviter les warnings tsup
- **`tsup`** : Bundler qui génère CJS + ESM + types .d.ts en un seul build
- **`prepublishOnly`** : Build automatique avant chaque `npm publish`
- **Version** : Incrémentée automatiquement dans le workflow

### 3. Configuration Azure Artifacts

#### Créer le feed Azure Artifacts

1. Va sur Azure DevOps → Artifacts
2. Crée un nouveau feed : `testazure-package`
3. Scope : Organization
4. Upstream sources : Activer npmjs.org

#### Générer un PAT (Personal Access Token)

1. Azure DevOps → User Settings → Personal Access Tokens
2. New Token
3. Name : `GitHub Actions - Artifacts`
4. Scopes : **Packaging (Read & Write)**
5. Copie le token (il sera affiché UNE SEULE FOIS)
6. **Encode en base64** : `echo -n "YOUR_PAT" | base64`

#### Configurer le fichier .npmrc

**⚠️ NE JAMAIS COMMITTER LE TOKEN !**

`packages/shared/.npmrc` (local) :
```
@mcigroupfrance:registry=https://pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/
always-auth=true
```

Le token sera ajouté dynamiquement dans le workflow GitHub Actions.

#### Ajouter le secret GitHub

1. GitHub → Settings → Secrets and variables → Actions
2. New repository secret
3. Name : `AZURE_ARTIFACTS_TOKEN`
4. Value : Le PAT encodé en base64

### 4. Workflow GitHub Actions - Package Shared

**Fichier** : `.github/workflows/main_api-testazure.yml`

Le package shared est **buildé et publié dans le workflow du backend** car ils sont liés.

```yaml
- name: Build and publish shared package to Azure Artifacts
  working-directory: packages/shared
  run: |
    # Install et build
    npm ci
    npm run build

    # Configure Azure Artifacts authentication
    echo "@mcigroupfrance:registry=https://pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/" > .npmrc
    echo "always-auth=true" >> .npmrc
    echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:username=mcigroupfrance" >> .npmrc
    echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:_password=${{ secrets.AZURE_ARTIFACTS_TOKEN }}" >> .npmrc
    echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:email=ci@github.com" >> .npmrc

    # Duplicate pour le path sans /registry/
    echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/:username=mcigroupfrance" >> .npmrc
    echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/:_password=${{ secrets.AZURE_ARTIFACTS_TOKEN }}" >> .npmrc
    echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/:email=ci@github.com" >> .npmrc

    # Increment version automatiquement
    CURRENT_VERSION=$(node -p "require('./package.json').version")
    echo "Current version: $CURRENT_VERSION"
    npm version patch --no-git-tag-version
    NEW_VERSION=$(node -p "require('./package.json').version")
    echo "New version: $NEW_VERSION"

    # Publish (ignore si version existe déjà)
    npm publish || echo "⚠️ Package already published or publish failed, continuing..."
```

**Points critiques :**

1. **Double configuration du registry** : Il faut configurer à la fois :
   - `.../npm/registry/:...` (pour le registry)
   - `.../npm/:...` (pour le publish)

2. **Incrément automatique de version** :
   - `npm version patch --no-git-tag-version` incrémente automatiquement
   - Pas besoin de commit la version incrémentée

3. **Ignore les erreurs de publish** :
   - Si la version existe déjà, le workflow continue
   - Évite les échecs inutiles en cas de re-run

### 5. Consommer le package dans les apps

#### Configuration .npmrc dans l'app consommatrice

`apps/backend/.npmrc` :
```
@mcigroupfrance:registry=https://pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/
always-auth=true
```

#### Installation locale

```bash
cd apps/backend
echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:_password=YOUR_BASE64_PAT" >> .npmrc
npm install @mcigroupfrance/shared
```

**⚠️ Attention** : Ajoute `.npmrc` avec le token au `.gitignore` !

#### Dans le workflow GitHub Actions

```yaml
- name: Configure Azure Artifacts authentication for backend
  working-directory: apps/backend
  run: |
    echo "@mcigroupfrance:registry=https://pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/" > .npmrc
    echo "always-auth=true" >> .npmrc
    echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:username=mcigroupfrance" >> .npmrc
    echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:_password=${{ secrets.AZURE_ARTIFACTS_TOKEN }}" >> .npmrc
    echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:email=ci@github.com" >> .npmrc

- name: Install backend dependencies
  working-directory: apps/backend
  run: npm ci
```

---

## Backend - Azure Web App

### 1. Structure du backend

```
apps/backend/
├── src/
│   ├── server.ts                 # Point d'entrée Fastify
│   ├── plugins/
│   │   ├── prisma.plugin.ts      # Plugin Prisma Client
│   │   └── jwt.plugin.ts         # Plugin JWT + authenticate decorator
│   ├── routes/
│   │   ├── auth.route.ts
│   │   ├── providers.route.ts
│   │   └── provider-types.route.ts
│   └── services/
│       ├── auth.service.ts
│       ├── providers.service.ts
│       └── provider-types.service.ts
├── prisma/
│   └── schema.prisma             # Schéma Prisma (IMPORTANT pour Azure !)
├── dist/                         # Build TypeScript (généré)
├── start.sh                      # Script de démarrage Azure (CRITIQUE !)
├── package.json
├── tsconfig.json
└── .npmrc                        # Config Azure Artifacts
```

### 2. Configuration package.json

```json
{
  "name": "backend",
  "version": "1.0.0",
  "main": "dist/server.js",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "sh start.sh",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:studio": "prisma studio",
    "prisma:push": "prisma db push"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.1",
    "@fastify/jwt": "^9.0.1",
    "@prisma/client": "^6.1.0",
    "@mcigroupfrance/shared": "^1.0.0",
    "bcrypt": "^5.1.1",
    "fastify": "^5.2.0",
    "fastify-plugin": "^5.0.1",
    "prisma": "^6.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.2",
    "@types/node": "^22.0.0",
    "dotenv-cli": "^11.0.0",
    "pino-pretty": "^13.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.0"
  }
}
```

**⚠️ POINT CRITIQUE** : `prisma` doit être dans `dependencies`, PAS dans `devDependencies` !

**Pourquoi ?**
- Azure App Service peut faire `npm install --production` ou `npm ci --omit=dev`
- Si `prisma` est en devDependencies, il ne sera pas installé
- Le script de démarrage `start.sh` a besoin de `prisma` pour générer le client

### 3. Configuration Prisma - Schéma spécial pour Azure

`apps/backend/prisma/schema.prisma` :

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model ProviderType {
  id         Int        @id @default(autoincrement())
  name       String     @unique
  label      String
  jsonSchema String     // ⚠️ String, PAS Json !
  createdAt  DateTime   @default(now())
  updatedAt  DateTime   @updatedAt
  providers  Provider[]

  @@map("provider_types")
}

model Provider {
  id             Int          @id @default(autoincrement())
  name           String
  email          String       @unique
  phone          String?
  address        String?
  providerTypeId Int
  providerType   ProviderType @relation(fields: [providerTypeId], references: [id])
  specificities  String       // ⚠️ String, PAS Json !
  status         String       @default("active")
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@index([providerTypeId])
  @@index([status])
  @@map("providers")
}
```

**⚠️ PIÈGE IMPORTANT** : Les champs JSON dynamiques

On utilise `String` au lieu de `Json` pour :
- `jsonSchema` : Contient le schéma JSON du type de fournisseur
- `specificities` : Contient les données dynamiques du fournisseur

**Pourquoi String et pas Json ?**

Prisma génère le type `JsonValue` pour les champs `Json`, mais ce type n'est pas compatible avec nos types custom. Avec `String`, on fait :

```typescript
// Dans les services
const provider = await prisma.provider.findUnique({ where: { id } });
return {
  ...provider,
  specificities: JSON.parse(provider.specificities), // ✅ Type-safe
};

// Pour créer/update
await prisma.provider.create({
  data: {
    specificities: JSON.stringify(data.specificities), // ✅ Type-safe
  },
});
```

C'est plus verbeux mais parfaitement type-safe sans `as any`.

### 4. Script de démarrage Azure (CRITIQUE !)

`apps/backend/start.sh` :

```bash
#!/bin/sh
echo "=== Starting deployment script ==="
echo "Generating Prisma Client..."

# Use node directly to avoid permission issues with npx
node ./node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma

echo "Prisma Client generated successfully!"
echo "Starting Fastify server..."
node dist/server.js
```

**Pourquoi ce script est-il nécessaire ?**

Azure App Service (Linux) a une limitation : lors du déploiement via Zip Deploy, le script Kudu utilise :

```bash
tar -zcf ../node_modules.tar.gz *
```

Le pattern `*` **exclut automatiquement les fichiers/dossiers cachés** (ceux qui commencent par `.`).

Résultat : `node_modules/.prisma/` est **exclu du déploiement** !

**Solution officielle Microsoft/Prisma** : Générer le Prisma Client au démarrage du container.

**Pourquoi `node ./node_modules/prisma/build/index.js` au lieu de `npx prisma` ?**
- Évite les problèmes de permissions avec les binaires
- Chemin relatif `./node_modules` (pas `/node_modules`) pour s'adapter à l'environnement Azure
- Spécification explicite du schema avec `--schema=./prisma/schema.prisma`

**Rendre le script exécutable** : Le `chmod +x` est fait dans le workflow GitHub Actions (voir ci-dessous).

### 5. Workflow GitHub Actions - Backend

**Fichier** : `.github/workflows/main_api-testazure.yml`

```yaml
name: API build and deploy

on:
  push:
    branches:
      - main
    paths:
      - "apps/backend/**"
      - "packages/shared/**"
      - ".github/workflows/main_api-testazure.yml"
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js version
        uses: actions/setup-node@v3
        with:
          node-version: "22.x"

      # ===== ÉTAPE 1 : BUILD ET PUBLISH DU PACKAGE SHARED =====
      - name: Build and publish shared package to Azure Artifacts
        working-directory: packages/shared
        run: |
          npm ci
          npm run build

          # Configure npm authentication for Azure Artifacts
          echo "@mcigroupfrance:registry=https://pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/" > .npmrc
          echo "always-auth=true" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:username=mcigroupfrance" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:_password=${{ secrets.AZURE_ARTIFACTS_TOKEN }}" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:email=ci@github.com" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/:username=mcigroupfrance" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/:_password=${{ secrets.AZURE_ARTIFACTS_TOKEN }}" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/:email=ci@github.com" >> .npmrc

          # Increment version to next patch
          CURRENT_VERSION=$(node -p "require('./package.json').version")
          echo "Current version: $CURRENT_VERSION"
          npm version patch --no-git-tag-version
          NEW_VERSION=$(node -p "require('./package.json').version")
          echo "New version: $NEW_VERSION"

          # Try to publish, ignore error if version already exists
          npm publish || echo "⚠️ Package already published or publish failed, continuing..."

      # ===== ÉTAPE 2 : CONFIGURE AUTH POUR LE BACKEND =====
      - name: Configure Azure Artifacts authentication for backend
        working-directory: apps/backend
        run: |
          echo "@mcigroupfrance:registry=https://pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/" > .npmrc
          echo "always-auth=true" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:username=mcigroupfrance" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:_password=${{ secrets.AZURE_ARTIFACTS_TOKEN }}" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:email=ci@github.com" >> .npmrc

      # ===== ÉTAPE 3 : INSTALL DEPENDENCIES =====
      - name: Install backend dependencies
        working-directory: apps/backend
        run: npm ci

      # ===== ÉTAPE 4 : GENERATE PRISMA CLIENT (pour le build TS) =====
      - name: Generate Prisma Client
        working-directory: apps/backend
        run: npx prisma generate

      # ===== ÉTAPE 5 : BUILD TYPESCRIPT =====
      - name: Build backend
        working-directory: apps/backend
        run: npm run build

      # ===== ÉTAPE 6 : RENDRE LE SCRIPT DE DÉMARRAGE EXÉCUTABLE =====
      - name: Make startup script executable
        working-directory: apps/backend
        run: chmod +x start.sh

      # ===== ÉTAPE 7 : UPLOAD ARTIFACT =====
      - name: Upload artifact for deployment job
        uses: actions/upload-artifact@v4
        with:
          name: node-app
          path: apps/backend

  # ===== JOB 2 : DEPLOY SUR AZURE =====
  deploy:
    runs-on: ubuntu-latest
    needs: build
    environment:
      name: "Production"
      url: ${{ steps.deploy-to-webapp.outputs.webapp-url }}

    steps:
      - name: Download artifact from build job
        uses: actions/download-artifact@v4
        with:
          name: node-app

      - name: "Deploy to Azure Web App"
        id: deploy-to-webapp
        uses: azure/webapps-deploy@v3
        with:
          app-name: "api-testazure"
          slot-name: "Production"
          package: .
          publish-profile: ${{ secrets.AZUREAPPSERVICE_PUBLISHPROFILE_6FCD020F8E334C2F9492DC7B0E5F063D }}
```

**Points critiques du workflow :**

1. **Trigger paths** : Le workflow se déclenche si :
   - `apps/backend/**` change
   - `packages/shared/**` change (car le backend dépend du shared)
   - Le workflow lui-même change

2. **Ordre des étapes** : RESPECTER cet ordre !
   - Build & publish shared AVANT d'installer les deps du backend
   - Configure auth Azure Artifacts AVANT npm ci
   - Generate Prisma AVANT le build TypeScript (sinon erreurs de types)
   - chmod +x start.sh AVANT l'upload (sinon permission denied sur Azure)

3. **L'artifact uploadé contient** :
   - `dist/` : Code TypeScript compilé
   - `node_modules/` : Toutes les dépendances (sauf `.prisma/`)
   - `prisma/` : **ESSENTIEL** pour que start.sh puisse générer le client
   - `package.json` : Pour Azure
   - `start.sh` : Script de démarrage
   - `.npmrc` : Config Azure Artifacts (sans token, juste le registry)

### 6. Configuration Azure Web App

#### Créer la Web App

1. **Azure Portal** → Create a resource → Web App
2. Configuration :
   - **Name** : `api-testazure` (ou ton nom)
   - **Publish** : Code
   - **Runtime stack** : Node 22 LTS
   - **Operating System** : Linux
   - **Region** : Europe (West Europe par exemple)
   - **Plan** : Basic B1 minimum (Free tier ne supporte pas les slots)

#### Configuration de l'app

**Settings → Configuration → General settings** :

```
Stack : Node
Major version : 22
Minor version : 22 LTS
Startup Command : npm start
```

**⚠️ IMPORTANT** : Le Startup Command doit être **exactement** `npm start`

Cela va exécuter le script `start` du `package.json`, qui lui-même exécute `sh start.sh`.

#### Variables d'environnement

**Settings → Configuration → Application settings** :

Ajoute ces variables :

```
DATABASE_URL = postgresql://user:password@host:5432/dbname?sslmode=require
JWT_SECRET = ton_secret_jwt_super_secure_minimum_32_caracteres
PORT = 8080
NODE_ENV = production
```

**⚠️ IMPORTANT** :
- Azure définit automatiquement `PORT=8080`
- Ton serveur Fastify doit écouter sur `process.env.PORT || 3000`

#### Récupérer le Publish Profile pour GitHub

**Deployment → Deployment Center** :

1. Click sur "Manage publish profile"
2. Download publish profile
3. Copie tout le contenu XML
4. GitHub → Settings → Secrets → New secret
5. Name : `AZUREAPPSERVICE_PUBLISHPROFILE_[RANDOM_ID]`
6. Value : Le contenu XML complet

**Note** : Le nom exact du secret doit correspondre à celui dans le workflow YAML.

#### Logs et monitoring

**Monitoring → Log stream** : Voir les logs en temps réel

**Monitoring → App Service logs** : Activer les logs d'application

```
Application Logging : File System
Level : Information
```

### 7. Variables d'environnement locales vs Azure

#### Développement local

`.env` (à la racine de `apps/backend/`, **NON COMMITÉ**) :

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/testazure?schema=public"
JWT_SECRET="dev_secret_minimum_32_caracteres_pour_jwt"
PORT=3000
NODE_ENV="development"
```

#### Production Azure

Variables définies dans Azure Portal → Configuration → Application settings (voir section ci-dessus).

---

## Prisma sur Azure - Particularités

### Le problème du dossier .prisma

**Symptôme** : Erreur au démarrage sur Azure :
```
Error: Cannot find module '.prisma/client/default'
```

**Cause** : Le script Kudu d'Azure utilise `tar -zcf ../node_modules.tar.gz *`, où `*` exclut les dossiers cachés comme `.prisma/`.

**Solution** : Générer le Prisma Client au démarrage avec `start.sh` (voir section Backend).

### Pourquoi pas postinstall ?

On a testé d'ajouter `"postinstall": "prisma generate"` dans le `package.json`, mais :
- Azure fait parfois `npm install --production` qui skip les scripts
- Le timing d'exécution n'est pas garanti
- Les permissions peuvent poser problème

Le script de démarrage `start.sh` est **plus fiable**.

### Migrations Prisma sur Azure

**Pour appliquer les migrations en production** :

Option 1 : Manuellement via Kudu Console
```bash
cd /home/site/wwwroot
node ./node_modules/prisma/build/index.js migrate deploy
```

Option 2 : Ajouter dans start.sh (NON RECOMMANDÉ en prod)
```bash
node ./node_modules/prisma/build/index.js migrate deploy
node dist/server.js
```

**⚠️ Danger** : Les migrations auto en prod peuvent causer des downtimes. Préférer les migrations manuelles ou via un job séparé.

Option 3 : Job de migration séparé dans le workflow (RECOMMANDÉ)

Ajouter un step avant le déploiement :

```yaml
- name: Run Prisma migrations
  working-directory: apps/backend
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL_PRODUCTION }}
  run: npx prisma migrate deploy
```

### Prisma Studio en production

**NE JAMAIS** exposer Prisma Studio en production. Utilise-le uniquement en local :

```bash
cd apps/backend
npm run prisma:studio
```

---

## Frontend - Azure Static Web Apps

### 1. Structure du frontend

```
apps/frontend/
├── app/
│   ├── layout.tsx                # Root layout avec metadata
│   ├── page.tsx                  # Page d'accueil (/)
│   ├── providers.tsx             # Wrapper AuthProvider (client component)
│   ├── login/
│   │   └── page.tsx              # Page de login
│   └── dashboard/                # Pages dashboard (protégées)
│       ├── page.tsx
│       ├── providers/
│       │   ├── page.tsx
│       │   ├── new/page.tsx
│       │   ├── [id]/page.tsx
│       │   └── [id]/edit/page.tsx
│       └── provider-types/
│           └── ...
├── components/
│   ├── ui/                       # Composants Shadcn/UI
│   ├── login-form.tsx
│   ├── providers/
│   └── provider-types/
├── contexts/
│   └── AuthContext.tsx           # Context d'authentification
├── lib/
│   ├── api/
│   │   ├── client.ts             # Axios instance avec interceptors
│   │   ├── auth.api.ts
│   │   ├── providers.api.ts
│   │   └── provider-types.api.ts
│   └── utils.ts                  # Utilitaires (cn, etc.)
├── public/                       # Fichiers statiques
├── .next/                        # Build output (généré)
│   └── standalone/               # Mode standalone pour Azure
├── package.json
├── next.config.ts                # Config Next.js (output: 'standalone')
├── tailwind.config.ts
├── tsconfig.json
└── .npmrc                        # Config Azure Artifacts
```

### 2. Configuration package.json

```json
{
  "name": "frontend",
  "version": "0.1.0",
  "private": true,
  "engines": {
    "node": ">=20.9.0"
  },
  "scripts": {
    "dev": "next dev",
    "build": "next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/",
    "start": "next start",
    "lint": "eslint"
  },
  "dependencies": {
    "@mcigroupfrance/shared": "^1.0.0",
    "@radix-ui/react-dialog": "^1.1.15",
    "axios": "^1.13.2",
    "next": "16.0.3",
    "react": "19.2.0",
    "react-dom": "19.2.0",
    "react-hook-form": "^7.66.1",
    "zod": "^4.1.12",
    "zustand": "^5.0.8"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.0.3",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
```

**Points clés :**

1. **`engines.node`** : `>=20.9.0` (minimum pour Next.js 16, mais Azure Static Web Apps supporte seulement Node 18 et 20)

2. **Script `build` CRITIQUE** :
```bash
next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
```

**Pourquoi cette commande ?**

Next.js en mode `standalone` génère un serveur Node.js minimal dans `.next/standalone/`, mais il **ne copie PAS automatiquement** :
- Les fichiers statiques générés (`.next/static/` : CSS, JS, chunks)
- Les fichiers publics (`public/` : favicon, images, etc.)

Ces copies sont **obligatoires** pour que l'app fonctionne sur Azure Static Web Apps.

**Source** : [Microsoft - Deploy Next.js Hybrid](https://learn.microsoft.com/en-us/azure/static-web-apps/deploy-nextjs-hybrid)

3. **Dependencies** :
- `@mcigroupfrance/shared` : Package privé depuis Azure Artifacts
- Next.js 16.0.3 avec React 19
- Tailwind CSS 4
- Axios pour les appels API
- React Hook Form + Zod pour les formulaires
- Zustand pour le state management (alternatif à AuthContext)

### 3. Configuration Next.js

`apps/frontend/next.config.ts` :

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Configuration pour Azure Static Web Apps (déploiement hybride)
  output: 'standalone',
};

export default nextConfig;
```

**⚠️ CRITIQUE** : `output: 'standalone'` est **OBLIGATOIRE** pour Azure Static Web Apps en mode hybride.

**Qu'est-ce que le mode standalone ?**

- Génère un serveur Node.js autonome dans `.next/standalone/`
- Inclut seulement les dépendances nécessaires (optimisé)
- Permet le SSR (Server-Side Rendering) sur Azure Static Web Apps
- Sans ça, Azure ne peut faire que du SSG (Static Site Generation)

**Mode hybride = SSR + SSG** : Certaines pages sont statiques (○), d'autres dynamiques (ƒ).

### 4. Configuration Azure Artifacts (.npmrc)

`apps/frontend/.npmrc` :

```
@mcigroupfrance:registry=https://pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/
always-auth=true
```

**⚠️ Important** : Le token est ajouté dynamiquement dans le workflow GitHub Actions, ne JAMAIS committer le token !

### 5. Workflow GitHub Actions - Frontend

**Fichier** : `.github/workflows/azure-static-web-apps-blue-pebble-03ee8ce03.yml`

```yaml
name: Frontend build and deploy

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened, closed]
    branches:
      - main

jobs:
  build_and_deploy_job:
    if: github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.action != 'closed')
    runs-on: ubuntu-latest
    name: Build and Deploy Job
    steps:
      - uses: actions/checkout@v3
        with:
          submodules: true
          lfs: false

      # ===== ÉTAPE 1 : SETUP NODE.JS =====
      - name: Set up Node.js version
        uses: actions/setup-node@v3
        with:
          node-version: "20.9"  # Azure Static Web Apps supporte Node 18 et 20 seulement

      # ===== ÉTAPE 2 : CONFIGURE AZURE ARTIFACTS AUTH =====
      - name: Configure Azure Artifacts authentication
        run: |
          # Add credentials to existing .npmrc (keeps ignore-scripts and registry config)
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:username=mcigroupfrance" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:_password=${{ secrets.AZURE_ARTIFACTS_TOKEN }}" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/registry/:email=ci@github.com" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/:username=mcigroupfrance" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/:_password=${{ secrets.AZURE_ARTIFACTS_TOKEN }}" >> .npmrc
          echo "//pkgs.dev.azure.com/mcigroupfrance/testazure/_packaging/testazure-package/npm/:email=ci@github.com" >> .npmrc

          # Copy to apps/frontend for Oryx
          cp .npmrc apps/frontend/.npmrc

          echo "✅ Azure Artifacts authentication configured"

      # ===== ÉTAPE 3 : BUILD ET DEPLOY VIA AZURE ORYX =====
      - name: Build And Deploy
        id: builddeploy
        uses: Azure/static-web-apps-deploy@v1
        env:
          NEXT_PUBLIC_API_URL: ${{ secrets.NEXT_PUBLIC_API_URL }}
          NODE_VERSION: "20"  # Force Oryx à utiliser Node 20
        with:
          azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN_BLUE_PEBBLE_03EE8CE03 }}
          repo_token: ${{ secrets.GITHUB_TOKEN }}
          action: "upload"
          app_location: "/apps/frontend/"  # Source de l'app
          api_location: ""  # Pas d'API Functions
          output_location: ""  # Vide pour Next.js hybride/standalone

  close_pull_request_job:
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    name: Close Pull Request Job
    steps:
      - name: Close Pull Request
        id: closepullrequest
        uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN_BLUE_PEBBLE_03EE8CE03 }}
          action: "close"
```

**Points critiques du workflow :**

1. **Node.js version : 20.9**
   - Next.js 16 requiert Node 20.9 minimum
   - Azure Static Web Apps supporte **seulement Node 18 et 20** (pas Node 22 !)
   - Variable `NODE_VERSION: "20"` force Azure Oryx à utiliser Node 20

2. **Configuration Azure Artifacts**
   - Créer le `.npmrc` à la racine avec les credentials
   - **Copier** le `.npmrc` dans `apps/frontend/` pour qu'Oryx le trouve
   - Double configuration registry (avec `/registry/` et sans)

3. **Variables d'environnement**
   - `NEXT_PUBLIC_API_URL` : URL de l'API backend (ex: `https://api-testazure.azurewebsites.net`)
   - Passée en `env:` dans le step "Build And Deploy"
   - Accessible dans le code Next.js via `process.env.NEXT_PUBLIC_API_URL`

4. **Paramètres Azure Static Web Apps Deploy**
   - `app_location: "/apps/frontend/"` : Dossier source de l'app
   - `api_location: ""` : Vide (on n'utilise pas Azure Functions)
   - `output_location: ""` : **VIDE pour Next.js hybride** ! Ne PAS mettre `.next` ou `.next/standalone`
   - `skip_app_build` : **Pas utilisé** - Oryx détecte Next.js et fait le build automatiquement

5. **Azure Oryx**
   - Détecte automatiquement Next.js (via `package.json`)
   - Fait `npm ci` puis `npm run build`
   - Le script build copie les fichiers statiques dans `.next/standalone/`
   - Oryx détecte `.next/` et configure le déploiement

### 6. Configuration Azure Static Web App

#### Créer la Static Web App

1. **Azure Portal** → Create a resource → Static Web App
2. Configuration :
   - **Name** : `frontend-testazure` (ou ton nom)
   - **Plan type** : Free (ou Standard pour custom domain, etc.)
   - **Region** : West Europe (ou proche de ton backend)
   - **Deployment source** : GitHub
   - **Organization** : Ton organisation GitHub
   - **Repository** : testAzure2
   - **Branch** : main
   - **Build Presets** : Next.js
   - **App location** : `/apps/frontend/`
   - **Api location** : (vide)
   - **Output location** : (vide)

3. **Authentication** : Azure génère automatiquement un token et l'ajoute comme secret GitHub

#### Configuration de l'app

**Settings → Configuration → Application settings** :

```
NEXT_PUBLIC_API_URL = https://api-testazure.azurewebsites.net
```

**⚠️ IMPORTANT** : Les variables `NEXT_PUBLIC_*` doivent être configurées :
1. Dans le workflow GitHub Actions (pour le build)
2. Dans Azure Static Web App Configuration (pour les previews et le runtime)

#### Récupérer le token pour GitHub (si non auto-configuré)

**Settings → Configuration → Deployment token** :

1. Copie le token
2. GitHub → Settings → Secrets → New secret
3. Name : `AZURE_STATIC_WEB_APPS_API_TOKEN_[RANDOM_ID]`
4. Value : Le token
5. Le nom exact doit correspondre à celui dans le workflow YAML

### 7. Variables d'environnement

#### Développement local

`.env.local` (à la racine de `apps/frontend/`, **NON COMMITÉ**) :

```bash
NEXT_PUBLIC_API_URL=http://localhost:3000
```

#### Production Azure

Variables définies dans :
1. **Workflow GitHub Actions** (env: dans le step Build And Deploy)
2. **Azure Portal** → Configuration → Application settings

**⚠️ Les deux doivent être synchronisés !**

### 8. Authentification dans l'app

#### AuthContext

`apps/frontend/contexts/AuthContext.tsx` :

```typescript
'use client';

import { createContext, useContext, useState, useEffect } from 'react';
import { authApi } from '@/lib/api';
import type { User } from '@mcigroupfrance/shared';

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      authApi.me().then(setUser).catch(() => {
        localStorage.removeItem('token');
      }).finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    const { token, user } = await authApi.login(email, password);
    localStorage.setItem('token', token);
    setUser(user);
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
```

#### Axios Client avec Interceptors

`apps/frontend/lib/api/client.ts` :

```typescript
import axios from 'axios';

const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor pour ajouter le token JWT
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Interceptor pour gérer les erreurs 401 (redirection login)
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default apiClient;
```

#### Layout avec Providers

**PIÈGE Next.js** : On ne peut pas mettre `'use client'` dans `layout.tsx` si on exporte `metadata`.

**Solution** : Créer un composant `providers.tsx` séparé :

`apps/frontend/app/providers.tsx` :

```typescript
'use client';

import { AuthProvider } from '@/contexts/AuthContext';

export function Providers({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
```

`apps/frontend/app/layout.tsx` :

```typescript
import type { Metadata } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'App Title',
  description: 'App Description',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

### 9. Routes et pages

#### Routes statiques vs dynamiques

```
Route (app)
┌ ○ /                                    # Statique (SSG)
├ ○ /_not-found                          # Statique
├ ○ /dashboard                           # Statique
├ ○ /dashboard/provider-types            # Statique
├ ƒ /dashboard/provider-types/[id]/edit  # Dynamique (SSR)
├ ○ /dashboard/provider-types/new        # Statique
├ ○ /dashboard/providers                 # Statique
├ ƒ /dashboard/providers/[id]            # Dynamique (SSR)
├ ƒ /dashboard/providers/[id]/edit       # Dynamique (SSR)
├ ○ /dashboard/providers/new             # Statique
└ ○ /login                               # Statique

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

**Explication** :
- **Pages avec `[id]`** : Routes dynamiques → SSR
- **Pages sans params** : Routes statiques → SSG (pré-générées)

#### Exemple de page dynamique

`apps/frontend/app/dashboard/providers/[id]/page.tsx` :

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { providersApi } from '@/lib/api';
import type { Provider } from '@mcigroupfrance/shared';

export default function ProviderDetailPage() {
  const params = useParams();
  const id = Number(params.id);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    providersApi.getById(id)
      .then(setProvider)
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [id]);

  if (isLoading) return <div>Chargement...</div>;
  if (!provider) return <div>Fournisseur non trouvé</div>;

  return (
    <div>
      <h1>{provider.name}</h1>
      <p>{provider.email}</p>
    </div>
  );
}
```

### 10. Next.js 16 - Particularités

#### React 19

Next.js 16 utilise React 19 (RC), qui peut avoir des incompatibilités avec certaines libs.

**Problèmes courants** :
- Certains packages Radix UI nécessitent des mises à jour
- React Hook Form fonctionne bien
- Vérifier la compatibilité des dépendances

#### Tailwind CSS 4

Tailwind CSS 4 (beta) a une nouvelle config :

`tailwind.config.ts` :

```typescript
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
```

**⚠️ Import CSS** : Dans `app/globals.css` :

```css
@import "tailwindcss";
```

Au lieu de l'ancien :
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### 11. Troubleshooting Frontend

#### Node version 22.20.0 is not supported

**Symptôme** :
```
Node version 22.20.0 is not supported. Please use one of the following versions 18, 20.
```

**Cause** : Azure Static Web Apps ne supporte que Node 18 et 20.

**Solutions** :
1. Mettre `node-version: "20.9"` dans le workflow
2. Mettre `"engines": { "node": ">=20.9.0" }` dans package.json
3. Ajouter `NODE_VERSION: "20"` dans env du step Deploy

#### Erreur Cannot find module '@mcigroupfrance/...'

**Symptôme** :
```
Type error: Cannot find module '@mcigroupfrance/shared'
```

**Solutions** :
1. Vérifier que le `.npmrc` est bien copié dans `apps/frontend/` dans le workflow
2. Vérifier que le token Azure Artifacts est valide
3. Vérifier le nom du package (pas `testazure-shared` mais `shared`)

#### NEXT_PUBLIC_API_URL non définie

**Symptôme** : Axios fait des appels à `undefined/api/...`

**Solutions** :
1. Ajouter la variable dans le workflow (env: du step Deploy)
2. Ajouter la variable dans Azure Static Web App Configuration
3. Vérifier qu'elle commence bien par `NEXT_PUBLIC_`

#### Build réussit mais app ne démarre pas

**Symptôme** : Le build passe mais l'app affiche une erreur 500 sur Azure

**Solutions** :
1. Vérifier que le script build copie bien les fichiers :
   ```bash
   next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
   ```
2. Vérifier que `output: 'standalone'` est dans `next.config.ts`
3. Check les logs Azure : Portal → Static Web App → Logs

#### Metadata export error avec 'use client'

**Symptôme** :
```
Error: You can't export metadata from a client component
```

**Solution** : Ne PAS mettre `'use client'` dans `layout.tsx`. Créer un `providers.tsx` séparé avec `'use client'`.

---

## Troubleshooting

### Package shared - Erreurs courantes

#### E401 Unauthorized lors de npm install

**Symptôme** :
```
npm ERR! code E401
npm ERR! 401 Unauthorized - GET https://pkgs.dev.azure.com/...
```

**Solutions** :
1. Vérifie que le PAT est bien encodé en base64
2. Vérifie que le PAT a les permissions "Packaging (Read & Write)"
3. Vérifie que le PAT n'est pas expiré
4. Vérifie que le `.npmrc` est bien configuré avec les DEUX paths :
   - `.../npm/registry/:...`
   - `.../npm/:...` (pour publish)

#### Package non trouvé après publish

**Symptôme** :
```
npm ERR! 404 Not Found - GET https://pkgs.dev.azure.com/.../shared/-/shared-1.0.5.tgz
```

**Solutions** :
1. Va sur Azure Artifacts, vérifie que le package apparaît
2. Vérifie la version publiée vs celle demandée dans package.json
3. Parfois il faut attendre 1-2 minutes que le cache se propage
4. Force refresh : `npm cache clean --force && npm install`

### Backend - Erreurs courantes

#### Cannot find module '.prisma/client/default'

**Symptôme** : Erreur au démarrage du serveur sur Azure

**Solutions** :
1. Vérifie que `start.sh` est présent et exécutable (chmod +x dans le workflow)
2. Vérifie que le dossier `prisma/` est bien inclus dans l'artifact
3. Vérifie que `prisma` est dans `dependencies`, PAS `devDependencies`
4. Vérifie les logs Azure : est-ce que "Generating Prisma Client..." apparaît ?

#### Error: prisma: Permission denied

**Symptôme** : Le script start.sh échoue avec une erreur de permission

**Solution** : Utilise `node ./node_modules/prisma/build/index.js` au lieu de `npx prisma` (voir start.sh)

#### Build fails: JsonValue is not assignable to string

**Symptôme** : Erreur TypeScript lors du build

```
Type 'JsonValue' is not assignable to type 'string'
```

**Solution** : Change les champs `Json` en `String` dans le schema Prisma et utilise `JSON.parse()`/`JSON.stringify()` dans les services.

#### Azure Web App ne redémarre pas après déploiement

**Solutions** :
1. Portal Azure → Ton Web App → Restart
2. Ou attends 2-3 minutes, le redémarrage peut être lent
3. Check les logs : Portal → Monitoring → Log stream

#### 502 Bad Gateway après déploiement

**Symptôme** : L'app ne répond pas, erreur 502

**Solutions** :
1. Check les logs (Log stream) pour voir l'erreur
2. Vérifie que ton serveur écoute sur `process.env.PORT` (pas hardcodé à 3000)
3. Vérifie que DATABASE_URL est bien configuré dans les Application Settings
4. Teste en local avec les mêmes variables d'environnement

### GitHub Actions - Erreurs courantes

#### Workflow fails at "Generate Prisma Client"

**Symptôme** :
```
Error: Failed to fetch sha256 checksum at https://binaries.prisma.sh/...
```

**Solutions** :
1. Problème temporaire chez Prisma, relance le workflow
2. Ou ajoute dans le step :
```yaml
env:
  PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: 1
```

#### Artifact upload trop gros

**Symptôme** :
```
Error: Artifact size exceeds maximum allowed size
```

**Solutions** :
1. Ajoute un `.artifactignore` dans apps/backend :
```
node_modules/.cache
node_modules/.prisma
*.log
.env
```

2. Ou exclue node_modules et laisse Azure faire npm install (mais attention au .prisma !)

---

## Checklist de déploiement

### Première fois (Setup)

**Azure Artifacts :**
- [ ] Créer le feed Azure Artifacts
- [ ] Générer et encoder le PAT Azure DevOps
- [ ] Ajouter le secret `AZURE_ARTIFACTS_TOKEN` dans GitHub

**Backend (Azure Web App) :**
- [ ] Créer l'Azure Web App (Node 22, Linux)
- [ ] Configurer les Application Settings (DATABASE_URL, JWT_SECRET, etc.)
- [ ] Télécharger et ajouter le Publish Profile comme secret GitHub
- [ ] Configurer la Startup Command : `npm start`

**Frontend (Azure Static Web App) :**
- [ ] Créer l'Azure Static Web App (Free ou Standard)
- [ ] Lier au repository GitHub
- [ ] Configurer Build Presets : Next.js
- [ ] App location : `/apps/frontend/`
- [ ] Output location : (vide)
- [ ] Ajouter le secret `AZURE_STATIC_WEB_APPS_API_TOKEN_*` dans GitHub (normalement auto)
- [ ] Configurer Application Settings : `NEXT_PUBLIC_API_URL`

### À chaque nouveau projet

- [ ] Copier la structure de dossiers (apps/, packages/)
- [ ] Copier les workflows GitHub Actions
- [ ] Adapter les noms dans package.json (@mcigroupfrance/shared → @ton-org/ton-package)
- [ ] Adapter les URLs Azure Artifacts dans les .npmrc et workflows
- [ ] Créer le schema Prisma (attention : String pour les Json dynamiques)
- [ ] Copier le start.sh dans apps/backend
- [ ] Vérifier que prisma est dans dependencies (backend)
- [ ] Configurer `output: 'standalone'` dans next.config.ts (frontend)
- [ ] Ajouter le script build avec cp dans package.json (frontend)
- [ ] Vérifier Node version : 22.x (backend), 20.9 (frontend)

### Avant chaque déploiement

**Backend :**
- [ ] Build local réussi : `npm run build` (backend)
- [ ] Tests Prisma : `npx prisma generate && npx prisma db push`
- [ ] Variables d'environnement à jour dans Azure Portal (Web App)

**Frontend :**
- [ ] Build local réussi : `npm run build` (frontend)
- [ ] Vérifier que NEXT_PUBLIC_API_URL est correct
- [ ] Variables d'environnement à jour dans Azure Portal (Static Web App)

**Global :**
- [ ] Commit et push sur main (ou branche configurée dans le workflow)

---

## Commandes utiles

### Package Shared (local)

```bash
cd packages/shared
npm run build                    # Build le package
npm publish                      # Publish sur Azure Artifacts
npm version patch                # Incrémente la version
```

### Backend (local)

```bash
cd apps/backend
npm run dev                      # Dev avec hot reload
npm run build                    # Build TypeScript
npm start                        # Démarre le serveur (via start.sh)

# Prisma
npm run prisma:generate          # Génère le client
npm run prisma:migrate          # Crée une migration
npm run prisma:push             # Push le schema sans migration
npm run prisma:studio           # Ouvre Prisma Studio
```

### Frontend (local)

```bash
cd apps/frontend
npm run dev                      # Dev avec hot reload (port 3001)
npm run build                    # Build Next.js + copie static/public
npm start                        # Démarre en mode production
npm run lint                     # ESLint
```

### Azure CLI (optionnel)

```bash
# Login
az login

# Liste des Web Apps
az webapp list --output table

# Logs en temps réel
az webapp log tail --name api-testazure --resource-group ton-resource-group

# Restart
az webapp restart --name api-testazure --resource-group ton-resource-group

# Variables d'environnement
az webapp config appsettings list --name api-testazure --resource-group ton-resource-group
```

---

## Ressources

**Backend & Prisma :**
- [Documentation Prisma sur Azure](https://www.prisma.io/docs/orm/prisma-client/deployment)
- [Azure App Service - Node.js](https://learn.microsoft.com/en-us/azure/app-service/quickstart-nodejs)
- [GitHub Issue Prisma + Azure](https://github.com/prisma/prisma/discussions/13409)
- [Microsoft Q&A - .prisma exclusion](https://learn.microsoft.com/en-us/answers/questions/2276283/azure-app-service-kudu-absolutetar-excludes-prisma)

**Frontend & Next.js :**
- [Deploy Next.js Hybrid to Azure Static Web Apps](https://learn.microsoft.com/en-us/azure/static-web-apps/deploy-nextjs-hybrid)
- [Next.js Standalone Output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- [Azure Static Web Apps Documentation](https://learn.microsoft.com/en-us/azure/static-web-apps/)

**Azure Artifacts :**
- [Azure Artifacts - npm](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc)

---

**Dernière mise à jour** : Novembre 2025

**Stack testée** :
- **Backend** : Node.js 22 LTS, Prisma 6.1.0, Fastify 5.2.0, Azure App Service Linux
- **Frontend** : Node.js 20.9, Next.js 16.0.3, React 19, Tailwind CSS 4, Azure Static Web Apps
- **Shared** : TypeScript 5.6, Zod 3.23, tsup 8.0, Azure Artifacts
