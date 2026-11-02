# OriCode Agent

Agente integrado en el panel secundario de OriCode. Usa Ollama o el gateway OriCode Cloud sin dependencias adicionales.

## Arranque

Desde `C:\Users\alexp\Desktop\oricode`:

~~~powershell
.\run-oricode.bat
~~~

Si OriCode ya está abierto, ejecuta **Developer: Reload Window** desde la paleta de comandos (Ctrl+Shift+P). El comando **OriCode: Focus OriCode Agent** muestra el panel.

El lanzador compila el agente y desactiva las extensiones de Copilot para esta aplicación. El modo predeterminado es Cloud. Pulsa **Iniciar sesión con OriCode** (o ejecuta **OriCode: Iniciar Sesión en la Web**): se abre `https://oricode.orizonstudio.cloud/auth/ide/`, inicias sesión en la web y el IDE recupera automáticamente la cuenta y los modelos.

El retorno utiliza un puerto temporal en `127.0.0.1` y un estado aleatorio por intento, con caducidad de tres minutos. No requiere instalar un protocolo de Windows. El IDE verifica la clave con `/api/auth/ide/me` —y, si la cuenta no tiene acceso a esa ruta, con `/v1/models`— antes de guardarla en SecretStorage, vinculada al servidor. Chat y agente llaman a `/v1/chat/completions` directamente. No necesitan cuenta de GitHub ni Copilot. Cerrar sesión elimina la credencial del IDE.

Los archivos de la página de retorno están en `resources/oricode/auth/ide/` y se sirven en `/var/www/oricode/auth/ide/` del servidor. El enlace lleva `port` y `state` como parámetros separados para evitar que el abridor de URL del IDE codifique dos veces una dirección anidada. El flujo anterior del cliente instalado se conserva para visitas sin esos parámetros.

## Uso

- **Local** consulta los modelos instalados en Ollama. Los modelos con sufijo cloud se identifican como remotos y no se anuncian como ejecución gratuita local.
- **Cloud** requiere una clave orz_* válida del gateway. El catálogo procede del proveedor; los errores de autenticación y conexión se muestran en el panel. Adaptive prioriza modelos de código gratuitos del catálogo y muestra el modelo elegido. Si no hay modelos gratuitos, puede elegir uno de pago.
- **Code** solicita confirmación para cambios y comandos; **Smart** aplica archivos del proyecto y confirma comandos; **Ask** y **Plan** solo permiten lectura; **Bypass** ejecuta sin confirmación en un proyecto de confianza.
- El botón de envío se convierte en **Detener** durante una tarea. La cancelación no revierte archivos que ya se guardaron.
- El agente puede listar y leer archivos, sustituir un fragmento único, escribir archivos, consultar diagnósticos y ejecutar comprobaciones. Los comandos tienen un límite de 60 segundos; las tareas, 12 pasos de forma predeterminada.
- Los bloques con filename=RUTA se muestran como propuestas con botón **Revisar y aplicar** y comparación nativa cuando existe el archivo.
- El historial, modo y modelo se guardan por proyecto. **＋** inicia otra conversación. La sincronización cloud del historial es opcional y está desactivada de forma predeterminada.
- Los adjuntos son archivos de texto, hasta 1 MB; se envían como máximo 16.000 caracteres. El agente no analiza imágenes en esta versión.

## Configuración

Busca OriCode en Settings:

| Ajuste | Predeterminado |
| --- | --- |
| oricode.ollamaUrl | http://127.0.0.1:11434 |
| oricode.cloudUrl | https://oricode.orizonstudio.cloud |
| oricode.maxSteps | 12 |
| oricode.responseTimeout | 180000 ms por respuesta |
| oricode.syncHistory | false |

Los modelos locales grandes pueden tardar varios minutos dependiendo del hardware. El estado del paso y el razonamiento recibido son visibles; puedes detenerlos y seleccionar otro modelo. Los logos SVG están incluidos en media/providers y no dependen de una CDN. Fuente: [Lobe Icons](https://github.com/lobehub/lobe-icons), licencia MIT incluida en esa carpeta. Las marcas pertenecen a sus titulares.

## Validación

~~~powershell
npm --prefix extensions/oricode-agent run compile
npm --prefix extensions/oricode-agent test
~~~

Las pruebas cubren transporte HTTP/SSE/NDJSON, cancelación, errores de proveedor, aislamiento de rutas, permisos, edición, ejecución e historial. Las pruebas de interfaz usan playwright-core ya instalado en el repositorio y Chrome instalado en el equipo, sin descargar navegadores. Los proveedores de las pruebas son servidores locales simulados; no usan claves ni consumen créditos cloud.
