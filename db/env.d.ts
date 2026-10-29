declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    APP_CONFIG_ENCRYPTION_KEY?: string;
  }
}
