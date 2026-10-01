/**
 * A short path to the command registration.
 *
 * Some hosting panels cap the "main file" field — Pterodactyl's Node egg
 * allows sixteen characters, and `src/deploy-commands.js` is twenty-two. This
 * file exists so that registering commands on such a panel is a matter of
 * pointing it at `register.js` (eleven) rather than restructuring the project
 * around somebody else's form validation.
 *
 * Requiring the script runs it, exactly as `npm run deploy` does.
 */
require('./src/deploy-commands');
