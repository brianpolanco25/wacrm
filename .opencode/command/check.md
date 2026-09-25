---
description: Corre la compuerta completa de CI local en el orden de CI.
agent: leader
---

Corre la misma secuencia que exige CI (`.github/workflows/ci.yml`), en orden,
y no sigas al paso siguiente si el anterior falla:

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`

Reporta solo lo que fallo, con archivo y linea. Si todo pasa, dilo en una linea
sin adornos.

Cuando los cuatro pasen, refresca el grafo con `graphify update .`. No forma
parte de CI y no bloquea la compuerta: si falla, informalo en una linea. No
arregles nada salvo que el usuario lo pida.
