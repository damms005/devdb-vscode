import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
	schema: './src/db/schema.ts',
	dialect: 'postgresql',
	dbCredentials: {
		host: process.env.PGVECTOR_HOST ?? 'localhost',
		port: 5433,
		user: 'devdb',
		password: process.env.PGVECTOR_PASSWORD,
		database: 'vectors',
	},
})
