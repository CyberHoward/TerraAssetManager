require('dotenv').config()
import config from './config'
import { Bot } from './src/Bot'

const bot = new Bot(config)

async function main() {
	await bot.execute()
	bot.clearCache()
	setTimeout(main, config.options.waitFor * 1000)
}

main()
