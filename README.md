# Tu día

Organizador diario simple, sin backend propio: guarda todo en el
navegador (`localStorage`) y, opcionalmente, sincroniza entre
dispositivos con Firebase Firestore.

## Estructura

```
index.html        Estructura de la página (sin estilos ni lógica embebidos)
styles.css         Estilos
js/
  app.js           Lógica de la app: DOM, eventos, Firebase
  logic.mjs         Lógica pura (sin DOM ni red) — testeada
tests/
  logic.test.mjs    Tests de js/logic.mjs
firestore.rules     Reglas de seguridad de Firestore (ver el archivo para
                     instrucciones de despliegue manual)
```

No hay build ni bundler: es HTML/CSS/JS servido tal cual (por ejemplo,
con GitHub Pages). `js/app.js` importa `js/logic.mjs` como módulo ES
nativo del navegador.

## Tests

Requieren Node.js 18+ (usan el test runner incorporado, sin
dependencias):

```
npm test
```

## Desarrollo local

Al ser módulos ES, hace falta servir los archivos por http(s) — abrir
`index.html` directamente con `file://` no funciona (los navegadores
bloquean módulos JS locales por seguridad). Por ejemplo:

```
python3 -m http.server 8000
# abrir http://localhost:8000
```
