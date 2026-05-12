---
name: qa
description: Golden-path QA de los 4 roles de Marzam usando Playwright MCP. Usa los 4 botones demo quick-login en la página de login y valida render por rol + (cuando hay assignments) flujo de visita del rep. Reporta gaps del demo mock layer cuando los detecta.
---

# /qa [role...]

Corre golden-path QA contra los 4 roles de Marzam usando Playwright MCP. Diseñado para correrse antes de cherry-pick `main → qa`.

## Argumentos

- `/qa` — corre los 4 roles (director, gerente, supervisor, rep).
- `/qa rep` — corre solo rep.
- `/qa rep gerente` — corre dos roles arbitrarios.

## Pre-flight (abortar si falla)

1. Detectar el port del dev server. El default histórico en CLAUDE.md es 4000, pero la `.env` local suele ponerlo en 3000. Probar en este orden y usar el primero que responda:
   - `http://localhost:3000/api/health`
   - `http://localhost:4000/api/health`
2. Si ninguno responde, **abortar** con: "Server no responde en :3000 ni :4000. Levantar con `npm run dev` antes de correr /qa."
3. Verificar `process.env.NODE_ENV !== 'production'` y que `health.env` no sea `production`.
4. Confirmar que `health.checks.external_db === 'ok'` (si no, advertir — algunos flujos dependen del external DB).

## Credenciales / login

La página `/` (al navegar a `/app` se redirige si no hay sesión) tiene **4 botones demo quick-login**, uno por rol:

| Rol | Texto del botón (accessible name) | user_id |
|-----|-----------------------------------|---------|
| director | "Director Vista completa" | u-dir-001 |
| gerente | "Gerente Sup + Reps" | u-ger-001 |
| supervisor | "Supervisor Mis Reps" | u-sup-001 |
| rep | "Representante Mi ruta" | u-rep-001 |

Usar `page.getByRole('button', { name: '<accessible name>' }).click()`. Esto es más rápido y robusto que llenar el formulario manual.

Form manual (fallback): textbox "Correo electrónico", textbox "Contraseña", button "Iniciar sesión". Los demo users usan password `Demo2026!`.

Estos usuarios están bloqueados de writes por `src/middleware/demoReadonly.js`. Las escrituras responden 200 con header `X-Demo-Mode: readonly` y body con `_demo: true` + `_demo_note`. Lecturas pasan al backend normal — algunos endpoints están mock-eados frontend-side por `demoHierarchy.js`.

## Golden path por rol

### Setup común (todos los roles)

1. Navegar a `${BASE_URL}/app` (BASE_URL detectado en pre-flight).
2. Si la URL redirige a `/`, hacer click en el botón demo correspondiente del rol.
3. Esperar redirect a `/app` con título "Marzam — Plataforma Comercial".
4. **Dismiss tutorial dialog si aparece:** existe un dialog "¡Hola, <Rol>!" en primer login. Click "Ahora no" (o "No mostrar de nuevo" si quieres persistir). Si no aparece, continuar.
5. Verificar banner "Demo · <Rol>" visible en la esquina (selector text-based).
6. `evaluate` `() => ({ token: !!localStorage.getItem('token'), user: JSON.parse(localStorage.getItem('user') || 'null')?.role })`. Assert `token === true` y `user` matches el rol esperado.

### director / gerente

1. Verificar que la sidebar/nav muestra tabs apropiados (al menos "Mis rutas" o "Mi equipo", según el rol).
2. Click tab principal correspondiente.
3. Esperar render (no timeout específico — depende del demo mock layer).
4. Capturar `mcp__playwright__browser_snapshot` con `depth: 3` para verificación visual.

### supervisor

1. Verificar tabs visibles.
2. Click "Mis rutas" (button by text).
3. Esperar panel "Mis rutas" en heading o título.

### rep — flujo de visita

**Status del flujo end-to-end (validado 2026-05-12):** el demo mock layer NO cubre `/api/visit-plans/assignments` ni `/api/visit-sessions/active/*` para `u-rep-001` — devuelven 401 "Endpoint no disponible en demo". Esto rompe el flujo completo de visita con el demo rep. Es una limitación del mock, no del skill.

**Mientras el demo no soporte assignments**, el rep flow se reduce a:

1. Login + verificar redirect a `/app` ✓
2. Tutorial dialog dismissed ✓
3. Banner "Demo · Representante" presente ✓
4. Nav muestra tabs "Mis rutas" y "Analíticas" ✓
5. Botón "Iniciar Modo Visita" presente ✓
6. **Detectar console errors:** si hay errores 401 contra `/api/visit-plans/assignments` o `/api/visit-sessions/*`, reportar como WARNING (mock gap conocido), no como FAIL.

**Cuando el demo mock layer cubra assignments**, expandir a:
- Seleccionar primera asignación del combobox del header (la población combobox actualmente, NO `#sel-assignment`).
- Click "Iniciar Modo Visita".
- Seleccionar outcome (`interested` u otro).
- Adjuntar foto mock (PNG 1x1 base64).
- Click submit.
- `browser_network_requests` filtrar por POST a `/api/visits*` o `/api/visit-sessions/*`. Assert:
  - Status 200
  - Header `x-demo-mode: readonly`
  - Body contains `_demo: true` + `_demo_note: 'Cambio simulado · no persistido en BD'`
- UI muestra éxito.

## Safety nets

- Cerrar el browser context con `mcp__playwright__browser_close` después de cada rol para reset limpio.
- Si email pasado al skill no es uno de los 4 demo conocidos → error: "El skill /qa solo acepta los 4 demo roles. Recibido: <input>".
- **Crítica de seguridad**: si la response del POST de visita NO incluye `_demo: true`, alerta MAYOR — significa que `demoReadonly` no interceptó y la BD pudo haberse modificado. Reportar prominentemente.
- Abortar si `health.env === 'production'` o hostname contiene producción.

## Reporte final

```
QA report (env: development, port: 3000):
- director:    pass  (1.4s)   [login → render]
- gerente:     pass  (1.6s)   [login → render]
- supervisor:  fail  (5.0s)   [tutorial dialog block — Ahora no no encontrado]
- rep:         partial (2.1s) [login OK; assignments 401 (mock gap conocido)]

Summary: 3 pass (1 partial), 1 fail
Warnings: demo mock layer no cubre /api/visit-plans/assignments
```

Para roles que fallaron, listar después los errores con selector y stack trace abreviado.

## Cuándo NO correr

- Producción detectada (env, hostname).
- Server no responde en 3000 ni 4000.
- Credenciales/usuarios demo cambiaron desde la última actualización de este SKILL.md — revisar `src/public/data/demo-hierarchy.json` y `/api/auth/login` directamente.

## Notas de mantenimiento

- Si los botones de demo quick-login cambian de texto/nombre accesible, actualizar la tabla de credenciales.
- Si el dialog de bienvenida cambia su selector ("Ahora no" → otro), actualizar el dismissal step.
- Si la response de `demoReadonly` cambia su shape, actualizar las assertions del paso de visit submit. Ver `src/middleware/demoReadonly.js` función `buildMockResponse`.
- Si el demo mock layer extiende cobertura a `/api/visit-plans/assignments`, expandir el rep flow al test end-to-end completo.

## Origen

Inspirado en el workflow de Gary Tan (Lightcone YC) — cierra el loop de testing manual antes de cherry-pick `main → qa`.
