import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import type { Env } from '../types'

export const createAuth = (d1: D1Database, env: Env) => {
  return betterAuth({
    database: drizzleAdapter(drizzle(d1), {
      provider: 'sqlite',
      schema,
      usePlural: false,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    trustedOrigins: [
      'http://localhost:8787',
      env.BETTER_AUTH_URL,
    ],
    emailAndPassword: {
      enabled: false,
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: 'select_account',
      },
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
      microsoft: {
        clientId: env.MICROSOFT_CLIENT_ID,
        clientSecret: env.MICROSOFT_CLIENT_SECRET,
        tenantId: 'common',
      },
    },
    account: {
      accountLinking: {
        enabled: false,
      },
    },
    user: {
      additionalFields: {
        plan: {
          type: 'string',
          required: false,
          defaultValue: 'free',
          input: false,
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
