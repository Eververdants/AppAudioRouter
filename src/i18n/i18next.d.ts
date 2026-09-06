// Type augmentation so t() keys are checked against the resource shape.
import type en from './locales/en.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: {
      translation: typeof en;
    };
  }
}
