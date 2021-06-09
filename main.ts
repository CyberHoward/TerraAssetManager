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
		const message = await ctx.replyWithHTML('Loading...')
		const ltv = await bot.computeLTV()
		ctx.telegram.editMessageText(
			message.chat.id,
			message.message_id,
			undefined,
			`Your LTV is <code>${ltv.toFixed(3)}%</code>`,
			{ parse_mode: 'HTML' }
		)
	})

	tgBot.command('set', (ctx) => {
		const [, path, value] = ctx.message.text.split(' ')
		bot.set(path, value)
		ctx.replyWithHTML(`Configuration changed. <code>${path}</code> is now at <code>${value}</code>`)
	})

	tgBot.command('goto', async (ctx) => {
		const [, amount] = ctx.message.text.split(' ')

		if (!Number.isInteger(+amount)) {
			ctx.reply('Send a correct number')
			return
		}

		ctx.replyWithHTML(`Going to <code>${amount}%</code>`)
		await bot.execute(+amount, 'tgBot')
	})

	tgBot.catch((e) => {
		// @ts-expect-error Typing
		if (e.response) {
			// @ts-expect-error Typing
			console.error('[Error Telegraf]', e.response)
		} else {
			console.error('[Error Telegraf]', e)
		}
	})

	tgBot.launch()
}

async function main() {
	try {
		await bot.execute()
	} catch (e) {
		if (e.response) {
			Logger.log(`An error occured\n${e.response?.data}`)
		} else {
			Logger.log(`An error occured\n${e}`)
		}

		bot.clearQueue('main')
		Logger.clearChannel('main')
	} finally {
		bot.stopExecution()
		bot.clearCache()
	}

	setTimeout(main, config.options.waitFor * 1000)
}

main()
