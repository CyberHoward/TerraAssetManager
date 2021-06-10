require('dotenv').config()
import dedent from 'dedent-js'
import { Telegraf } from 'telegraf'
import config from './config'
import { Bot } from './src/Bot'
import { Logger } from './src/Logger'

const bot = new Bot(config)

if (config.telegram.apiKey) {
	const tgBot = new Telegraf(config.telegram.apiKey)

	tgBot.command('ping', (ctx) => ctx.reply('Pong!'))

	tgBot.command('info', (ctx) => {
		const { config, wallet } = bot.getContext()

		ctx.replyWithHTML(dedent`<b>v0.2.5 - Anchor Borrow / Repay Bot</b>
			Made by Romain Lanz
			
			<b>Network:</b> <code>${config.chainId === 'columbus-4' ? 'Mainnet' : 'Testnet'}</code>
			<b>Address:</b>
			<a href="https://finder.terra.money/${config.chainId}/address/${wallet}">
				${wallet}
			</a>
			
			<u>Configuration:</u>
				- <b>SAFE:</b> <code>${config.ltv.safe}%</code>
				- <b>LIMIT:</b> <code>${config.ltv.limit}%</code>
				- <b>BORROW:</b> <code>${config.ltv.borrow}%</code>
		`)
	})

	tgBot.command('compound', () => {
		bot.compound()
	})

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

if (process.env.MNEMONIC && process.env.MNEMONIC.split(' ').length !== 24) {
	throw new Error('Invalid mnemonic key provided.')
}

if (process.env.LCD_URL && !process.env.LCD_URL.startsWith('https://')) {
	throw new Error('Invalid LCD URL provided.')
}

if (process.env.CHAIN_ID && process.env.CHAIN_ID.split('-').length !== 2) {
	throw new Error('Invalid CHAIN ID provided.')
}

if (config.ltv.limit > 49) {
	throw new Error('ltv.limit is too high.')
}

if (config.ltv.safe >= config.ltv.limit) {
	throw new Error('ltv.safe is too high.')
}

if (config.ltv.borrow >= config.ltv.safe) {
	throw new Error('ltv.borrow is too high.')
}

main()
