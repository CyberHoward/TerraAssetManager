require('dotenv').config()
import { Telegraf } from 'telegraf'
import config from './config'
import { Bot } from './src/Bot'
import { Logger } from './src/Logger'

const bot = new Bot(config)

if (config.telegram.apiKey) {
	const tgBot = new Telegraf(config.telegram.apiKey)

	tgBot.command('ping', (ctx) => ctx.reply('Pong!'))

	// tgBot.command('compound', () => {
	// 	bot.compound()
	// })

	tgBot.command('ltv', async (ctx) => {
		const ltv = await bot.computeLTV()
		ctx.reply(`Your LTV is ${ltv.toFixed(3)}%`)
	})

	tgBot.command('set', (ctx) => {
		const [, path, value] = ctx.message.text.split(' ')
		bot.set(path, value)
		ctx.reply(`Configuration changed. ${path} is now at ${value}`)
	})

	tgBot.command('goto', async (ctx) => {
		const [, amount] = ctx.message.text.split(' ')

		if (!Number.isInteger(+amount)) {
			ctx.reply('Send a correct number')
		}

		await bot.execute(+amount, 'tgBot')
	})

	tgBot.catch((e) => {
		console.log(e)
	})

	tgBot.launch()
}

async function main() {
	try {
		await bot.execute()
	} catch (e) {
		Logger.log(`An error occured\n${e.response.data}`)
		bot.clearQueue('main')
		Logger.clearChannel('main')
	} finally {
		bot.clearCache()
	}

	setTimeout(main, config.options.waitFor * 1000)
}

main()
