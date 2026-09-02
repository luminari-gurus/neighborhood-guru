import { AUTH_MODES, AUTH_MODE_VALUES } from './constants.js';
import { loadOidcConfig } from './oidc/config.js';
export function loadAuthConfig(environment = process.env) {
  const mode = environment.AUTH_MODE || AUTH_MODES.DISABLED;
  if (!AUTH_MODE_VALUES.includes(mode)) throw new Error('AUTH_MODE must be disabled, optional, or required');
  const production = environment.NODE_ENV === 'production';
  const databasePath = environment.AUTH_DATABASE_PATH || '';
  const secret = environment.AUTH_SECRET || '';
  if (mode !== AUTH_MODES.DISABLED && !databasePath) throw new Error('Authentication is enabled but AUTH_DATABASE_PATH is missing');
  if (mode !== AUTH_MODES.DISABLED && production && secret.length < 32) throw new Error('Authentication is enabled but AUTH_DATABASE_PATH or a 32+ character AUTH_SECRET is missing');
  const oidc = mode === AUTH_MODES.DISABLED ? null : loadOidcConfig(environment, { production });
  return Object.freeze({ mode, databasePath: databasePath || ':memory:', secret, production, oidc });
}
