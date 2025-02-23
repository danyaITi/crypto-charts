/** @format */

import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import svgr from 'vite-plugin-svgr';

export default defineConfig({
  resolve: {
    alias: {
      '@app': path.resolve(__dirname, './src/app'),
      '@assets': path.resolve(__dirname, './src/assets'),
      '@shared': path.resolve(__dirname, './src/shared'),
      '@pages': path.resolve(__dirname, './src/pages'),
    },
  },
  plugins: [react(), svgr({include: '**/*.svg?react'})],
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@app/styles/_variables.scss" as *;`,
      },
    },
  },
});
