import { dset } from 'dset'
import dedent from 'dedent-js'
import Decimal from 'decimal.js'
import { Coin, Coins, Denom, LCDClient, MnemonicKey, Msg, MsgExecuteContract, MsgSwap, StdFee, Wallet } from '@terra-money/terra.js'
import {
	AddressProviderFromJson,
	Anchor,
	COLLATERAL_DENOMS,
	columbus4,
	MARKET_DENOMS,
	tequila0004,
} from '@anchor-protocol/anchor.js'
import {DEFAULT_TEQUILA_MIRROR_OPTIONS, DEFAULT_MIRROR_OPTIONS, Mirror, AssetInfo, Token, Asset, MirrorMint} from '@mirror-protocol/mirror.js'
import { Logger } from './Logger'

const MICRO_MULTIPLIER = 1_000_000

// TODO: See if we can make it dynamic
type Channels = { main: Msg[]; tgBot: Msg[] }
type ChannelName = keyof Channels

function isBoolean(v) {
	return ['true', true, '1', 1, 'false', false, '0', 0].includes(v)
}

function toBoolean(v) {
	return ['true', true, '1', 1].includes(v)
}

type BotStatus = 'IDLE' | 'RUNNING' | 'PAUSE';

export class Bot {
    #failureCount = 0
	#walletDenom: any
	#config: Record<string, any>
	#cache: Map<string, Decimal> = new Map()
	#client: LCDClient
    #anchor: Anchor
    #balance: Decimal
    #mirror: Mirror
    #LPs: Map<string,string>= new Map() // <asset_adress, LP_adress>
	#madress: Map<string,string>= new Map() // <asset_adress, asset_name>
    #massets: Map<string,[string,string,string]> = new Map() //<asset_name, [asset_adress, position_id, LTV ]
	#wallet: Wallet
	#txChannels: Channels = { main: [], tgBot: [] }
	#status: BotStatus = 'IDLE'
	#addressProvider: AddressProviderFromJson

	constructor(config: any) {
		this.#config = config 

		// Initialization of the Terra Client
		this.#client = new LCDClient({
			URL: this.#config.lcdUrl,
			chainID: this.#config.chainId,
			gasPrices: '0.15uusd',
		})

		// Initialization of the Anchor Client
		const provider = this.#config.chainId === 'columbus-4' ? columbus4 : tequila0004
		this.#addressProvider = new AddressProviderFromJson(provider)
		this.#anchor = new Anchor(this.#client, this.#addressProvider)

        // Intialize Mirror Client
        let miroptions = this.#config.chainId === 'columbus-4' ? DEFAULT_MIRROR_OPTIONS : DEFAULT_TEQUILA_MIRROR_OPTIONS
		miroptions.lcd = this.#client
        miroptions.collateralOracle = "terra1q3ls6u2glsazdeu7dxggk8d04elnvmsg0ung6n"
        this.#mirror = new Mirror(miroptions);
        

        // What mAsset pools do i want
        this.#LPs = this.#config.LPs
        this.#LPs.forEach((el) =>{
            //this.#massets.
            
            if(miroptions.assets[el]){
                Logger.log(el)
                this.#massets.set(el,[miroptions.assets[el].token, "", ""])
            }
            Logger.log(this.#massets)
        })

		// Initialization of the user Wallet
		const key = new MnemonicKey({ mnemonic: this.#config.mnemonic })
		this.#wallet = new Wallet(this.#client, key)

		this.#walletDenom = {
			address: this.#wallet.key.accAddress,
			market: Denom.USD,
		}

        


		Logger.log(dedent`<b>v0.2.6 - Anchor Borrow / Repay Bot</b>
				Made by Romain Lanz
				
				<b>Network:</b> <code>${this.#config.chainId === 'columbus-4' ? 'Mainnet' : 'Testnet'}</code>
				<b>Address:</b>
				<a href="https://finder.terra.money/${this.#config.chainId}/address/${this.#wallet.key.accAddress}">
					${this.#wallet.key.accAddress}
				</a>
				
				<u>Configuration:</u>
					- <b>SAFE:</b> <code>${this.#config.ltv.safe}%</code>
					- <b>LIMIT:</b> <code>${this.#config.ltv.limit}%</code>
					- <b>BORROW:</b> <code>${this.#config.ltv.borrow}%</code>
		`)
	}

	set(path: string, value: any) {
		if (path === 'ltv.limit') {
			if (+value > 49) {
				Logger.log('You cannot go over <code>49</code>.')
				return
			}

			value = +value
		}

		if (path === 'ltv.safe') {
			if (+value >= this.#config.ltv.limit) {
				Logger.log(`You cannot go over <code>${this.#config.ltv.limit}</code>.`)
				return
			}

			value = +value
		}

		if (path === 'ltv.borrow') {
			if (+value >= this.#config.ltv.safe) {
				Logger.log(`You cannot go over <code>${this.#config.ltv.safe}</code>.`)
				return
			}

			value = +value
		}

		if (path === 'options.shouldBorrowMore') {
			if (!isBoolean(value)) {
				Logger.log(`The value must be a boolean (true/false).`)
				return
			}

			value = toBoolean(value)
		}

		dset(this.#config, path, value)
		Logger.log(`Configuration changed. <code>${path}</code> is now at <code>${value}</code>`)
	}

	run() {
		if (this.#status !== 'PAUSE') {
			Logger.log('Bot should be paused to run this command')
			return
		}

		this.#status = 'IDLE'
		Logger.log('Bot started')
	}

	pause() {
		this.#status = 'PAUSE'
		this.#failureCount = 0
		this.clearCache()
		this.clearQueue('main')
		this.clearQueue('tgBot')
		Logger.log('Bot paused')
	}

    async execute(goTo?: number, channelName: ChannelName = 'main') {
        if (this.#status === 'PAUSE') {
			if (channelName === 'tgBot') {
				Logger.log('Bot is paused, use <code>/run</code> to start it.')
			}

			return
		}

		if (this.#status === 'RUNNING') {
			if (channelName === 'tgBot') {
				Logger.log('Already running, please retry later.')
			}

			if (this.#failureCount >= 5) {
				Logger.log('It seems that the bot is stuck! Restarting...')
				this.pause()
				setTimeout(() => this.run(), 1000)
			}

			this.#failureCount++
			return
		}
        this.#balance = await this.getUSTBalance()
        Logger.log('Account has ' + this.#balance + 'UST.')

		if (this.#balance.greaterThan(new Decimal(1000))){
			this.toBroadcast(this.computeDepositMessage(new Decimal(1000)), channelName)
			Logger.log("Deposited 100 UST")
			await this.broadcast(channelName)
			Logger.toBroadcast('Testing', channelName)
		}
		

		await this.getCDPs()
		await this.manageCDPs()
		//console.log(this.#LPs)
    }

    async getUSTBalance(): Promise<Decimal> {
		const coins = await this.#client.bank.balance(this.#wallet.key.accAddress)
		const ustCoin = coins.get(Denom.USD)

		if (!ustCoin) {
			return new Decimal(0)
		}

		return ustCoin.amount.dividedBy(MICRO_MULTIPLIER)
	}

    //What staked positions do I have? 
    async getCDPs(){ 
		
        const positions = (await this.#mirror.mint.getPositions(this.#wallet.key.accAddress)).positions
		
		this.#massets.forEach(async (value:[string,string,string],key: string) => {
			for (let j in positions){
				//console.log(positions[j].asset.info.token.contract_addr)
				//console.log(value[0])
				if(positions[j].asset.info.token.contract_addr === value[0]){ //Find matching asset adresses
					value[1] = positions[j].idx
					value[2] = (await this.calculateLTV(new Decimal(parseInt(positions[j].collateral.amount)),positions[j].asset))
				}
			}
		});
    }

	async manageCDPs(){
		this.#massets.forEach(async (value:[string,string,string],key: string) => {
			let assetMinLTV = parseFloat((await this.#mirror.mint.getAssetConfig(value[0])).min_collateral_ratio)
			if (parseFloat(value[2]) < assetMinLTV + this.#config.margin){
				console.log("WARNING!! LTV TO HIGH")
			}
		}); 

	}

    computeOpenPositionMessage(camount: Decimal, asset_name: string, margin = this.#config.margin){
        const asset_info: Token = {
            token:{
                contract_addr: this.#massets.get(asset_name)[0],
            }
        };
        const aUSTtoken: Token = {
            token:{
                contract_addr: this.#addressProvider.aTerra(),
            }
        };
        const aUSTAsset: Asset<AssetInfo> = {
            info: aUSTtoken,
            amount: camount.times(new Decimal(MICRO_MULTIPLIER)).floor().toString()
        }
            // NOG AANPASSEN 
        let ratio = new Decimal(margin).dividedBy(100).add(new Decimal(1.5)).toFixed(3);
        //Logger.log(this.#addressProvider.aTerra());
		//Logger.log(ratio)
		//Logger.log(aUSTAsset)
		

		const open: MirrorMint.HandleOpenPosition = {
			open_position: {
				collateral: aUSTAsset,
				asset_info: asset_info,
				collateral_ratio: ratio.toString(),
				
			}
		}
		
		let exMsg = new MsgExecuteContract(
            this.#wallet.key.accAddress,
            this.#addressProvider.aTerra(),
            {
                send:{
                    contract: this.#mirror.mint.contractAddress,
                    amount: (camount.times(new Decimal(MICRO_MULTIPLIER))).toFixed(0).toString(),
                    msg: open,
                }
            },
            new Coins
        )
		return [exMsg]
/*
		interface HandleOpenPosition {
        open_position: {
            collateral: Asset<AssetInfo>;
            asset_info: AssetInfo;
            collateral_ratio: string;
            short_params?: ShortParams;
        };
		



		HandleOpenPosition()
		let mintmessage = this.#mirror.mint.openPosition( aUSTAsset,asset_info, ratio);
        return mintmessage
		
         // This one doesn't sell the coins
		 */
    }

	async LPtoUST(amount: Decimal){

	}

	async calculateLTV(collateral: Decimal, asset: Asset<Token>) {
		let assetPrice = await this.#mirror.oracle.getPrice("uusd",asset.info.token.contract_addr) 
		let lentValue =  (1/parseFloat(assetPrice.rate)) * (parseFloat(asset.amount)/MICRO_MULTIPLIER);
		//console.log(collateral.toNumber())
		return ((collateral.toNumber()/MICRO_MULTIPLIER)/lentValue).toString()
	}

	// #massets: Map<string,[string]> = new Map() //<asset_name, [asset_adress, position_id, LTV ]
	async computeLTVmAsset() {

		const borrowedValue = await this.getmAssetBorrowedValue()
		const borrowLimit = await this.getmAssetBorrowLimit()

		return borrowedValue.dividedBy(borrowLimit.times(2)).times(100)
	}

	async computemAssetAmountToRepay(target = this.#config.ltv.safe) {
		const borrowedValue = await this.getBorrowedValue()
		const borrowLimit = await this.getBorrowLimit()
		const amountForSafeZone = new Decimal(target).times(borrowLimit.times(2).dividedBy(100))

		return borrowedValue.minus(amountForSafeZone)
	}

	computeDepositMessage(amount: Decimal) {
		return this.#anchor.earn
			.depositStable({ amount: amount.toFixed(3), market: MARKET_DENOMS.UUSD })
			.generateWithWallet(this.#wallet)
	}

    stopExecution() {
		this.#status = 'IDLE'
	}

	clearCache() {
		this.#cache.clear()
	}

    clearQueue(channelName: ChannelName) {
		this.#txChannels[channelName] = []
	}

    private toBroadcast(message: Msg | Msg[], channelName: ChannelName) {
		if (Array.isArray(message)) {
			this.#txChannels[channelName].push(...message)
			return
		}

		this.#txChannels[channelName].push(message)
	}

	private async broadcast(channelName: ChannelName) {
		try {
			const tx = await this.#wallet.createAndSignTx({ msgs: this.#txChannels[channelName] })
			await this.#client.tx.broadcast(tx)
		} catch (e) {
			Logger.log(`An error occured\n${JSON.stringify(e.response.data)}`)
		} finally {
			this.#txChannels[channelName] = []
		}
	}

	private async cache(key: string, callback: () => Promise<string>) {
		if (this.#cache.has(key)) {
			return this.#cache.get(key) as Decimal
		}

		const value = new Decimal(await callback())
		this.#cache.set(key, value)

		return value
	}
    
}

/*
        //await this.getStakedLPs()
        //Logger.log(this.#addressProvider.aTerra());
		//await this.execute([unstake])
        //this.toBroadcast(this.computeOpenPositionMessage(new Decimal(100),'mTSLA'), channelName)
		let fee = new StdFee(666666, '100000uusd')
		const messga = this.computeOpenPositionMessage(new Decimal(100),'mTSLA')
		const tx = await this.#wallet.createAndSignTx({messga, fee});
        const result = await this.#client.tx.broadcastSync(tx);       
		Logger.log(messga)
		

		/*Logger.log(messgab)
		const tx = await this.#wallet.createAndSignTx({ msgs: [messgab] })
		Logger.log(tx)
	    await this.#client.tx.broadcast(tx)
		//await this.broadcast(channelName)
        await this.getStakedLPs()
		
        
        //let p = await this.#mirror.assets
        //Logger.log(p)
        //Logger.log(this.#LPs)
        //Logger.log()
        
        //let p = await this.#mirror.collaterallOracle.getCollateralAssetInfos()
        //Logger.log(p)
 
        //let r = await this.#mirror.collaterallOracle.getConfig()

        
        // aUST, mAsset, colateralRation, Short? 

        //this.#mirror.mint.openPosition()
        */