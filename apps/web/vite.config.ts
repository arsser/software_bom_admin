import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const formatDateTime = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC`;
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.VITE_APP_VERSION || pkg.version),
    'import.meta.env.VITE_APP_BUILD_TIME': JSON.stringify(process.env.VITE_APP_BUILD_TIME || formatDateTime(new Date())),
    'import.meta.env.VITE_APP_GIT_SHA': JSON.stringify(process.env.VITE_APP_GIT_SHA || ''),
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    host: '0.0.0.0', // 绑定所有 IP 地址
    port: 5173,
    open: true
  }
});