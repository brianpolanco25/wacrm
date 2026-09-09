---
description: Corre la compuerta completa de CI en local, en el mismo orden
---

Corre la misma secuencia que exige CI (`.github/workflows/ci.yml`), en orden,
y **no sigas al paso siguiente si el anterior falla**:

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`

Reporta solo lo que falló, con el archivo y la línea. Si todo pasa, dilo en una
línea sin adornos.

Cuando los cuatro pasen —y solo entonces, porque cerrar un feature es
justamente esto— refresca el grafo de conocimiento:

5. `graphify update .`

No es parte de CI y no decide nada: tarda segundos, es AST puro y no gasta
modelo. Si falla, dilo en una línea y sigue; no bloquea la compuerta.

No arregles nada por tu cuenta salvo que te lo pida: primero quiero ver el
diagnóstico completo.
