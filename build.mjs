import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'

const watch = process.argv.includes('--watch')

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['src/main.tsx'],
	bundle: true,
	outfile: 'dist/app.js',
	format: 'esm',
	target: ['es2022'],
	jsx: 'automatic',
	jsxImportSource: 'preact',
	// Everything is inlined. The page must load from IPFS or file:// with no
	// requests to any host, so there are no external chunks and no CDN imports.
	external: [],
	minify: !watch,
	sourcemap: watch,
	logLevel: 'info',
	loader: { '.css': 'css' },
}

copyFileSync('index.html', 'dist/index.html')

if (watch) {
	const ctx = await esbuild.context(options)
	await ctx.watch()
	const { hosts, port } = await ctx.serve({ servedir: 'dist', host: '127.0.0.1' })
	console.log(`\n  dev server: http://${hosts[0]}:${port}\n`)
} else {
	await esbuild.build(options)
	console.log('built -> dist/')
}
