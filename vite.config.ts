import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react(), {
    name: 'collaboration-ice-development',
    configureServer(server) {
      server.middlewares.use('/api/collaboration-ice', async (req, res, next) => {
        try {
          const handler = await import(pathToFileURL(resolve('api/collaboration-ice.mjs')).href)
          await handler.default(req, res)
        } catch (error) { next(error) }
      })
    },
  }],
  build: { target: 'es2022' },
})
