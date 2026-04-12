import { createAuthClient } from 'better-auth/client'

const authClient = createAuthClient()

;(globalThis as any).oauthSignIn = async (provider: string) => {
  await authClient.signIn.social({
    provider: provider as any,
    callbackURL: '/dashboard',
  })
}
