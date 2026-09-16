import type { ApiRelease } from '../types';

import { release as v1_0 } from './2026-07-01-v1-0';
import { release as v1_1 } from './2026-09-15-v1-1';
import { release as v1_2 } from './2026-09-16-v1-2';

// Un archivo de contenido por versión (spec §7.8). Publicar una versión
// nueva es añadir un archivo y su línea aquí: el orden lo pone la fecha,
// no el autor.

export const API_RELEASES: ApiRelease[] = [v1_0, v1_1, v1_2].sort((a, b) =>
  b.date.localeCompare(a.date)
);
