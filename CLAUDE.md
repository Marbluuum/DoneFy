# Linkfy — contexto para Claude Code

Inbound LinkedIn automation. Alguien comenta una palabra clave en un post de
Martin, y desde ahí: like, respuesta pública, invitación **personalizada**, DM
calificador cuando aceptan, y seguimientos si se quedan callados.

Martin habla español (argentino). Respondele en español.

## Estado

El flujo corre entero: comentario → like → respuesta pública → invitación con
nota → detecta que aceptaron → DM → conversación con botonera o automática.

209 tests, todos verdes. `npm test` no necesita navegador ni cuenta: la base es
PGlite (Postgres compilado a wasm) y el DOM se prueba contra Chromium con
páginas sintéticas.

Falta: retirar invitaciones vencidas para recuperar cupo, y el constructor
visual de flujos.

## Comandos

```bash
npm start          # hace lo que falte y levanta agente + panel (localhost:2500)
npm run doctor     # diagnostica la cadena entera y dice qué está roto
npm run demo       # llena el panel corriendo el motor contra un LinkedIn simulado
npm test           # 209 tests
npm run init       # conecta la cuenta de LinkedIn (abre Chrome)
npm run db:push    # aplica el esquema
```

Martin tiene un atajo de shell: `linkfy`, `linkfy doctor`, `linkfy update`.

## Arquitectura

Dos mitades que se hablan sólo por la base de datos:

- **`apps/web`** — el panel. Nunca toca LinkedIn. Escribe jobs.
- **`packages/agent`** — corre en la máquina de Martin, maneja un perfil de
  Chrome persistente, y es lo único que actúa sobre la cuenta.
- **`packages/core`** — todo lo que decide algo, y es puro: el motor de
  secuencia, el playbook de conversación, el orquestador, las cuotas, la salud
  de la cuenta. Sin I/O, así que se testea sin navegador ni red.
- **`packages/db`** — esquema Drizzle y migraciones.

La cookie de sesión **nunca** sale del disco de Martin. No hay columna donde
guardarla, a propósito. Eso separa a Linkfy de las herramientas que se llevan
las cookies a la nube, y no es negociable.

## Reglas que no se tocan

- Sólo se le habla a gente que comentó primero. Nunca outreach en frío.
- El opt-out gana sobre cualquier paso pendiente.
- Una respuesta del lead corta la secuencia automática.
- Nunca dos mensajes sin que contesten.
- Nada se manda fuera del horario configurado.
- El pitch nunca sale solo, en ningún modo de autonomía.
- Las cuotas están por debajo de los límites de LinkedIn a propósito
  (80 invitaciones por semana móvil, 15 por día).

## Cómo trabajar acá

**Los comentarios explican por qué, no qué.** El código dice qué hace. Los
comentarios existen para el razonamiento que no sobrevive en el código: por qué
este orden, qué falla si se invierte, qué bug real motivó esta guarda. Si un
comentario repite la línea que tiene debajo, sobra.

**Los tests nombran el fallo que evitan.** `test('a like that fails does not
cost the reply')`, no `test('likeComment')`. Y el comentario adentro dice qué
se rompe en la vida real si eso deja de valer.

**Nada de mocks donde se pueda usar lo real.** El repositorio se prueba contra
Postgres de verdad porque todo lo interesante que hace es SQL, y un mock le da
la razón a lo que sea que el código haga.

**LinkedIn manda clases hasheadas** (`.bedba3e3`) que cambian en cada deploy.
Los comentarios, perfiles e invitaciones se extraen estructuralmente — anclados
en `aria-label`, en la forma de un `href`, en el orden del documento. La
mensajería todavía tiene clases reales y usa selectores. Cuál aplica es una
propiedad de la página, no una preferencia.

**Antes de dar algo por terminado, corré `npm test`.** Y si el cambio toca el
esquema, avisale a Martin que tiene que correr `npm run db:push`.

## Lo único que Claude no puede hacer

Loguearse a LinkedIn por él. `npm run init` abre Chrome y espera hasta cinco
minutos; la contraseña la pone Martin, una sola vez, y el perfil guarda la
sesión desde entonces.
