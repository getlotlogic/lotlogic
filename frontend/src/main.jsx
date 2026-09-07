import React from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './ui/ErrorBoundary.jsx';
import { ToastProvider } from './ui/Toast.jsx';
import { App } from './App.jsx';

createRoot(document.getElementById('root')).render(
  <ErrorBoundary label="the dashboard"><ToastProvider><App /></ToastProvider></ErrorBoundary>
);
