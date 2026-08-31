# Las pruebas

Se corren con el sandbox levantado (`npm start`) y una cuenta creada.

Leen las credenciales de la base, **no las llevan escritas**: una credencial
copiada a mano caduca en cuanto se recrea el negocio, y entonces la prueba falla
por su culpa y no por la del código. (Además, credenciales en un repositorio
público son credenciales quemadas.)

## Del sandbox solo

```bash
node pruebas/aislamiento.mjs  # que un negocio no llegue a lo de otro (la que más importa)
node pruebas/telefonos.mjs   # números sin código de país y demás imposibles
node pruebas/limites.mjs     # 4096 caracteres, medios que no existen
```

## De la interfaz

Necesitan un Chrome escuchando por CDP en el 9333:

```bash
chromium --remote-debugging-port=9333 &
node pruebas/caras-navegador.mjs   # las caras de los contactos
node pruebas/interfaz.mjs          # el recorrido de la interfaz
node pruebas/tema.mjs              # claro y oscuro, midiendo el contraste
node pruebas/formato.mjs           # negritas, cursivas y demás de WhatsApp
node pruebas/tildes.mjs            # los acuses ✓ ✓✓ ✓✓ azul
node pruebas/globos.mjs            # los no leídos
node pruebas/sse.mjs               # que la pantalla se entere sin sondear
node pruebas/scroll.mjs            # que no se baje sola al leer arriba
node pruebas/contactos.mjs         # crear, renombrar, foto, vaciar, eliminar
node pruebas/clientes-navegador.mjs # el formulario llega escrito y no admite repetidos
```

## Con una plataforma conectada

Lo que de verdad importa es que **tu plataforma entendiera** lo que el sandbox
le mandó: que el sobre saliera no significa que llegara bien. Esas pruebas
dependen de cómo guarde los datos cada plataforma, así que no vienen escritas
aquí — se escriben contra la tuya, comparando lo que ella guardó con lo que el
sandbox dice haber mandado.
