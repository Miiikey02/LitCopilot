// Supabase client — owns the whole credential flow.
//
// Sign-up, password hashing/storage and reset all happen inside Supabase; this
// app never sees or stores a password. After sign-in we hold only the short-
// lived access token, which the backend verifies on each request.
//
// Config comes from build-time env vars (frontend/.env):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
// The anon key is a publishable key and is safe in client code; row access is
// still enforced server-side by the verified user id.
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL || ''
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

// When Supabase isn't configured (local dev without accounts), the app runs
// signed-out and the backend attributes everything to a single local user.
export const authEnabled = Boolean(url && anonKey)

export const supabase = authEnabled
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null

/** Current access token, or null when signed out / auth disabled. */
export async function getAccessToken() {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data?.session?.access_token || null
}
