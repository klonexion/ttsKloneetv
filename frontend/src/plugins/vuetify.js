import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';

import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';

/**
 * Vuetify 3 con tema oscuro por default (T-001).
 *
 * El toggle claro/oscuro de T-013 **no toca este archivo**: la preferencia vive en
 * `app_settings` y `App.vue` la aplica en vivo con `theme.change(name)` en cuanto
 * el store la carga o el operador la cambia. `defaultTheme: 'dark'` sigue siendo el
 * default del arranque —el mismo que sirve el backend— para que la app no parpadee
 * mientras responde `GET /api/settings`, y el aspecto sea el pedido incluso si esa
 * petición falla. Los nombres de estos dos temas son los valores válidos de la
 * clave `theme`, así que añadir un tema nuevo implica ampliar `THEMES` en
 * `backend/src/settings/settings.js` y en `frontend/src/stores/settings.js`.
 */
export const vuetify = createVuetify({
  components,
  directives,
  icons: {
    defaultSet: 'mdi',
  },
  theme: {
    defaultTheme: 'dark',
    themes: {
      dark: {
        dark: true,
        colors: {
          primary: '#9146FF',
          secondary: '#BF94FF',
        },
      },
      light: {
        dark: false,
        colors: {
          primary: '#772CE8',
          secondary: '#9146FF',
        },
      },
    },
  },
});
