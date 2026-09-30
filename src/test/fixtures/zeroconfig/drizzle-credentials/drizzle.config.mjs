import { config } from 'dotenv'
config({ path: '.env.local' })

/** @type { import("drizzle-kit").Config } */
export default {
  schema: './schema.js',
  dialect: "mysql",
  dbCredentials: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env['DB_USER'],
    password: `${process.env.DB_PASSWORD}`,
    database: 'shop',
    ssl: { rejectUnauthorized: false },
  },
}
