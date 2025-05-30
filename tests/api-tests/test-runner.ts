import fs from 'node:fs/promises'
import path from 'node:path'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

import supertest from 'supertest'
import { createDatabase, getConfig, getDMMF, parseEnvValue } from '@prisma/internals'
import { getPrismaClient, objectEnumValues } from '@prisma/client/runtime/library'

import { config } from '@keystone-6/core'
import {
  createExpressServer,
  createSystem,
  generateArtifacts,
  withMigrate,
} from '@keystone-6/core/___internal-do-not-use-will-break-in-patch/artifacts'

import type {
  BaseKeystoneTypeInfo,
  KeystoneConfig,
  KeystoneConfigPre,
} from '@keystone-6/core/types'
import { dbProvider } from './utils'

// prisma checks
{
  const prismaEnginesDir = path.dirname(require.resolve('@prisma/engines/package.json'))
  const prismaEnginesDirEntries = readdirSync(prismaEnginesDir)
  const queryEngineFilename = prismaEnginesDirEntries.find(dir => dir.startsWith('libquery_engine'))
  if (!queryEngineFilename) throw new Error('Could not find query engine')
  process.env.PRISMA_QUERY_ENGINE_LIBRARY = path.join(prismaEnginesDir, queryEngineFilename)
}

async function getTestPrismaModuleInner(prismaSchemaPath: string, schema: string) {
  const config = await getConfig({ datamodel: schema, ignoreEnvVarErrors: true })
  const { datamodel } = await getDMMF({ datamodel: schema, previewFeatures: [] })
  const models = Object.values(datamodel.models).reduce<
    Record<string, (typeof datamodel.models)[number]>
  >((a, x) => ((a[x.name] = x), a), {})
  const enums = Object.values(datamodel.enums).reduce<
    Record<string, (typeof datamodel.enums)[number]>
  >((a, x) => ((a[x.name] = x), a), {})
  const types = Object.values(datamodel.types).reduce<
    Record<string, (typeof datamodel.types)[number]>
  >((a, x) => ((a[x.name] = x), a), {})

  return {
    PrismaClient: getPrismaClient({
      inlineDatasources: {}, // uh
      inlineSchemaHash: '', // uh
      relativeEnvPaths: {}, // uh
      relativePath: '', // uh

      activeProvider: config.datasources[0].activeProvider,
      clientVersion: '0.0.0',
      datasourceNames: config.datasources.map(d => d.name),
      dirname: path.dirname(prismaSchemaPath),
      engineVersion: '0000000000000000000000000000000000000000',
      generator: config.generators.find(g => parseEnvValue(g.provider) === 'prisma-client-js'),
      inlineSchema: schema,
      runtimeDataModel: { models, enums, types },
    }),
    Prisma: {
      DbNull: objectEnumValues.instances.DbNull,
      JsonNull: objectEnumValues.instances.JsonNull,
    },
  }
}

const prismaModuleCache = new Map<string, unknown>()
async function getTestPrismaModule(prismaSchemaPath: string, schema: string) {
  if (prismaModuleCache.has(schema)) return prismaModuleCache.get(schema)!
  return prismaModuleCache
    .set(schema, await getTestPrismaModuleInner(prismaSchemaPath, schema))
    .get(schema)!
}

type FloatingConfig<TypeInfo extends BaseKeystoneTypeInfo> = Omit<
  KeystoneConfigPre<TypeInfo>,
  'db'
> & {
  db?: Omit<KeystoneConfigPre<TypeInfo>['db'], 'provider' | 'url'>
}

export async function setupTestEnv<TypeInfo extends BaseKeystoneTypeInfo>(
  config_: FloatingConfig<TypeInfo>,
  serve: boolean = false,
  identifier?: string,
  wrap: (config: KeystoneConfig) => KeystoneConfig = x => x
) {
  const random = identifier ?? randomBytes(10).toString('base64url').toLowerCase()
  const cwd = join(tmpdir(), `ks6-tests-${random}`)
  try {
    await fs.mkdir(cwd)
  } catch (err) {
    if ((err as any).code !== 'EEXIST') throw err
    await fs.rm(cwd, { recursive: true })
    await fs.mkdir(cwd)
  }

  let dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new TypeError('Missing DATABASE_URL')

  if (dbUrl.startsWith('file:')) {
    dbUrl = `file:${join(cwd, 'test.db')}` // unique database files
  }

  if (dbUrl.startsWith('postgres:')) {
    const parsed = new URL(dbUrl)
    parsed.searchParams.set('schema', random.replace(/^pg_/g, 'p__')) // unique schema names, ^pg_ is reserved by postgres
    dbUrl = parsed.toString()
  }

  if (dbUrl.startsWith('mysql:')) {
    const parsed = new URL(dbUrl)
    parsed.pathname = random // unique database names
    dbUrl = parsed.toString()
  }

  const system = createSystem(
    wrap(
      config({
        ...config_,
        db: {
          provider: dbProvider,
          url: dbUrl,
          prismaClientPath: '.prisma',
          prismaSchemaPath: 'test-schema.prisma',
          ...config_.db,
        },
        types: {
          path: 'test-types.ts',
        },
        lists: config_.lists,
        graphql: {
          schemaPath: 'test-schema.graphql',
          ...config_.graphql,
        },
        ui: {
          isDisabled: true,
          ...config_.ui,
        },
      })
    )
  )

  const artifacts = await generateArtifacts(cwd, system)
  const paths = system.getPaths(cwd)

  await createDatabase(system.config.db.url, cwd)
  await withMigrate(paths.schema.prisma, system, async m => {
    await m.reset()
    await m.schema(artifacts.prisma, false)
  })

  const { context, connect, disconnect } = system.getKeystone(
    await getTestPrismaModule(paths.schema.prisma, artifacts.prisma)
  )

  if (dbProvider === 'sqlite') {
    await connect()
    await context.prisma.$queryRaw`PRAGMA journal_mode=WAL;`
    await disconnect()
  }

  if (serve) {
    const { expressServer: express, httpServer: http } = await createExpressServer(
      system.config,
      context
    )

    function gqlSuper(
      args: Parameters<typeof context.graphql.raw>[0] & { operationName?: string }
    ) {
      return supertest(express)
        .post(system.config.graphql?.path ?? '/api/graphql')
        .send(args)
        .set('Accept', 'application/json')
    }

    async function gql(...args: Parameters<typeof gqlSuper>) {
      const { body } = await gqlSuper(...args)
      return body
    }

    return {
      artifacts,
      connect,
      context,
      config: system.config,
      http,
      gql,
      gqlSuper,
      express,
      disconnect,
    } as const
  }

  async function gql(...args: Parameters<typeof context.graphql.raw>) {
    return await context.graphql.raw(...args)
  }

  return {
    artifacts,
    connect,
    context,
    config: system.config,
    // the non null assertions are wrong but better than casting as any or similar
    // and it doesn't really matter much since it's in tests so if it fails
    // the test fails and it's fine
    http: null!,
    express: null!,
    gql,
    gqlSuper: null!,
    disconnect,
  } as const
}

export function setupTestRunner<TypeInfo extends BaseKeystoneTypeInfo>({
  config: config_,
  serve = false,
  identifier,
  wrap,
}: {
  config: FloatingConfig<TypeInfo>
  serve?: boolean
  identifier?: string
  wrap?: (config: KeystoneConfig) => KeystoneConfig
}) {
  return (testFn: (args: Awaited<ReturnType<typeof setupTestEnv>>) => Promise<void>) =>
    async () => {
      const result = await setupTestEnv(config_, serve, identifier, wrap)

      await result.connect()
      try {
        return await testFn(result)
      } finally {
        await result.disconnect()
      }
    }
}

// WARNING: no support for onConnect
export function setupTestSuite<TypeInfo extends BaseKeystoneTypeInfo>({
  config: config_,
  serve = false,
  identifier,
  wrap,
}: {
  config: FloatingConfig<TypeInfo>
  serve?: boolean
  identifier?: string
  wrap?: (config: KeystoneConfig) => KeystoneConfig
}) {
  const result = setupTestEnv(config_, serve, identifier, wrap)

  afterAll(async () => {
    await (await result).disconnect()
  })

  return async () => {
    await (await result).connect()
    return result
  }
}
