import { Hono } from 'hono'
import { accounts, apiKeys } from '../db/schema'
import { generateId } from '../utils/id'
import { generateApiKey } from '../services/api-keys'
import { rateLimit } from '../middleware/rate-limit'
import { parseBody } from '../utils/validate'
import { CreateAccountSchema } from '../types'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

app.use('/v1/accounts', rateLimit(5, 60 * 60 * 1000))

app.post('/v1/accounts', async (c) => {
  const data = await parseBody(c, CreateAccountSchema)
  if (data instanceof Response) return data

  const db = c.get('db')
  const accountId = generateId()
  const apiKeyId = generateId()
  const { raw, hash, prefix } = await generateApiKey()

  await db.batch([
    db.insert(accounts).values({ id: accountId, name: data.name, createdBy: 'agent' }),
    db.insert(apiKeys).values({ id: apiKeyId, accountId, keyHash: hash, keyPrefix: prefix, name: 'default' }),
  ])

  return c.json({
    account: { id: accountId, name: data.name, plan: 'free', created_at: new Date().toISOString() },
    api_key: raw,
  }, 201)
})

export default app
