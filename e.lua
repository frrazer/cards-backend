local Service = {}
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local RetryPcall = require(ReplicatedStorage.Modules.Utils.RetryPcall)
local DataModule = require(script.Parent.Parent.ServerModules.DataModule)
local function GetProfile(p) return DataModule.GetProfile(p) end


--[[
	© Go Hard Games | PRIVATE INTERNAL CONFIG — DO NOT DISTRIBUTE
    Unauthorized sharing of this file or its contents is strictly prohibited.
]]
local AWS_DATA = {
	URLs = {
		Dev = "https://9245fbvhwb.execute-api.us-east-1.amazonaws.com/dev";
		Prod = "https://pus6c1qz58.execute-api.us-east-1.amazonaws.com/prod";	
	};
	KEYS = {
		Dev = "mIatPBXwesOE9vkrBL7IAlBgJIOLesxDgTDpfsKIUtoPh1jwxoDm";
		Prod = "OJVmQHMzRk2WjhzcsszkZ6RBZVAZa0PktzTklh9A1Tvk0SgRxG1t";
	};
	REQUIRED_HEADERS = { -- WAF Security
		["cGx3MyQzW3T5G4jZxgzUuoLo"] = "PrI3eBMOC4jmxqt5dX5KAvDY"
	};
	DEV_UNIVERSE_ID = 9140515237
}

local MAX_RPM = 400
local requestTimes = {}
local function Request(data: {
	path: string,
	method: string,
	headers: { [string]: string }?,
	body: string?,
	query: { [string]: string }?,
	})

	local now = os.clock()
	while (requestTimes[1] and requestTimes[1] < now - 60) do
		table.remove(requestTimes, 1); 
	end; if (#requestTimes >= MAX_RPM) then
		task.wait(requestTimes[1] + 60 - now)
		table.remove(requestTimes, 1)
		now = os.clock()
	end

	table.insert(requestTimes, now)
	local env = game.GameId == AWS_DATA.DEV_UNIVERSE_ID and "Dev" or "Prod"
	local headers = table.clone(data.headers or {})
	local queryParts = {}

	for k, v in (data.query or {}) do
		table.insert(queryParts, HttpService:UrlEncode(k) .. "=" .. HttpService:UrlEncode(v)) 
	end; local url = AWS_DATA.URLs[env] .. data.path
	if #queryParts > 0 then
		url = url .. "?" .. table.concat(queryParts, "&")
	end; for k, v in AWS_DATA.REQUIRED_HEADERS do
		headers[k] = v or "" end
	headers["Authorization"] = AWS_DATA.KEYS[env]

	return RetryPcall(function()
		local response = HttpService:RequestAsync({
			Url = url,
			Method = string.upper(data.method or "GET"),
			Headers = headers,
			Body = data.body
		})


		warn(`res`, response)

		if (not response.Success) then return response.StatusCode, response.Body end
		local body; pcall(function()
			body = HttpService:JSONDecode(response.Body)
		end)

		return response.StatusCode, (body ~= nil and body or response.Body)
	end, 3)
end

local CardsData = require(ReplicatedStorage.Modules.Card_Inventory_MODULE)
local function GetYPS(cardName)
	local cardData = CardsData:GetCardData(cardName)
	if not cardData then return 0 end
	return cardData.yenPerSecond or 0
end

function Service:Start()
	local success, code, body = Request({ path = "/protected/example" })
	warn(success, code, body)
end

type Inventory = {
	userId: string,
	packs: { [string]: number },
	cards: {{
		cardId: string,
		cardName: string,
		level: number,
		variant: string,
		yps: number,
		placed: boolean
	}},
	totalYps: number,
	version: number 
}

function Service:ReconcileFromBackend(profile, newInventory, player): boolean
	local userId = profile.UserIds[1]
	local success, code, body

	if newInventory then
		success, code, body = true, 200, newInventory
	else
		success, code, body = Request({ path = `/user/inventory/{userId}` })
	end

	if (not success or code ~= 200) then return false end
	local inventory = (newInventory and newInventory or body.data) :: Inventory

	local validCards = {}
	local profiledCards = {}
	for _, card in inventory.cards do
		validCards[`{card.cardId}:{card.cardName}`] = true 
	end

	for i = #profile.Data.Cards, 1, -1 do
		local card = profile.Data.Cards[i]
		local key = `{card.Card_ID}:{card.Card_Name}`
		if not validCards[key] then
			table.remove(profile.Data.Cards, i)
			continue
		end
		profiledCards[key] = true
	end

	for _, card in inventory.cards do
		local key = `{card.cardId}:{card.cardName}`

		if not table.find(profile.Data.Index, card.cardName) then
			table.insert(profile.Data.Index, card.cardName)
		end

		if (profiledCards[key]) then continue end
		profile.Data.Cards[#profile.Data.Cards + 1] = {
			Card_ID = card.cardId,
			Slot = 1,
			Generated = 0,
			Card_Name = card.cardName,
			Card_Variant = card.variant,
			Offline_VAL = 0,
			Placed = false,
		}
	end

	profile.Data.Packs = inventory.packs

	if player then
		DataModule.SyncProfileToFolders(player)
	end

	return true
end

function Service:GiveCard(player, cardName, variant, cardId)
	local userId = player.UserId
	local profile = GetProfile(player)
	if (not profile) then return false end

	if (not cardId) then
		cardId = HttpService:GenerateGUID(false):gsub("-", ""):sub(1, 16)
	end

	local yps = GetYPS(cardName)

	local success, code, body = Request({
		path = "/user/inventory/modify",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			userId = `{userId}`,
			operations = {{
				action = "addCard",
				card = {
					cardId = cardId,
					cardName = cardName,
					variant = variant or "Normal",
					level = 1,
					yps = yps,
					placed = false
				}
			}}
		})
	})

	if (not success or code ~= 200) then return false end
	local inventory = body.data :: Inventory
	self:ReconcileFromBackend(profile, inventory, player)
	return true
end

function Service:RemoveCard(player, cardId)
	local userId = player.UserId
	local profile = GetProfile(player)
	if (not profile) then return false end

	local success, code, body = Request({
		path = "/user/inventory/modify",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			userId = `{userId}`,
			operations = {{
				action = "removeCard",
				cardId = cardId
			}}
		})
	})

	if (not success or code ~= 200) then return false end
	local inventory = body.data :: Inventory
	self:ReconcileFromBackend(profile, inventory, player)
	return true
end

function Service:PlaceCard(player, cardId, placed)
	local userId = player.UserId
	local profile = GetProfile(player)
	if (not profile) then return false end

	local success, code, body = Request({
		path = "/user/inventory/modify",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			userId = `{userId}`,
			operations = {{
				action = "updateCardPlaced",
				cardId = cardId,
				placed = placed
			}}
		})
	})

	if (not success or code ~= 200) then return false end
	local inventory = body.data :: Inventory
	self:ReconcileFromBackend(profile, inventory, player)
	return true
end

function Service:GivePack(player, packName, quantity)
	warn(player, packName, quantity)
	local userId = player.UserId
	local profile = GetProfile(player)
	warn(profile)
	if (not profile) then return false end

	local success, code, body = Request({
		path = "/user/inventory/modify",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			userId = `{userId}`,
			operations = {{
				action = "addPack",
				packName = packName,
				quantity = quantity or 1
			}}
		})
	})

	warn(success, body, code)
	if (not success or code ~= 200) then return false end
	local inventory = body.data :: Inventory

	self:ReconcileFromBackend(profile, inventory, player)
	return true
end

function Service:RemovePack(player, packName, quantity)
	local userId = player.UserId
	local profile = GetProfile(player)
	if (not profile) then return false end

	local success, code, body = Request({
		path = "/user/inventory/modify",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			userId = `{userId}`,
			operations = {{
				action = "removePack",
				packName = packName,
				quantity = quantity or 1
			}}
		})
	})

	if (not success or code ~= 200) then return false end
	local inventory = body.data :: Inventory
	self:ReconcileFromBackend(profile, inventory, player)
	return true
end

function Service:SetCardLevel(player, cardId, level)
	local userId = player.UserId
	local profile = GetProfile(player)
	if not profile then return false end

	local success, code, body = Request({
		path = "/user/inventory/modify",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			userId = `{userId}`,
			operations = {{
				action = "setCardLevel",
				cardId = cardId,
				level = level
			}}
		})
	})

	if not success or code ~= 200 then return false end
	local inventory = body.data :: Inventory
	self:ReconcileFromBackend(profile, inventory, player)
	return true
end

function Service:BatchOperations(player, operations)
	local userId = player.UserId
	local profile = GetProfile(player)
	if (not profile) then return false end

	local success, code, body = Request({
		path = "/user/inventory/modify",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			userId = `{userId}`,
			operations = operations
		})
	})

	if (not success or code ~= 200) then return false end
	local inventory = body.data :: Inventory
	self:ReconcileFromBackend(profile, inventory, player)
	return true
end

type CardListing = {
	type: "card",
	cardId: string,
	cardName: string,
	cardLevel: number,
	cardVariant: string,
	sellerId: string,
	sellerUsername: string,
	cost: number,
	timestamp: string
}

type PackListing = {
	type: "pack",
	listingId: string,
	packName: string,
	sellerId: string,
	sellerUsername: string,
	cost: number,
	timestamp: string
}

type MarketplaceListing = CardListing | PackListing

type RapHistoryEntry = { date: string, rap: number }
type ItemRapData = { rap: number, history: { RapHistoryEntry } }
type MarketplaceHistory = {
	cards: { [string]: ItemRapData },
	packs: { [string]: ItemRapData }
}

function Service:ListCard(player, cardId, cost)
	local profile = GetProfile(player)
	if not profile then return false end

	local success, code, body = Request({
		path = "/marketplace/list",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			type = "card",
			userId = `{player.UserId}`,
			username = player.Name,
			cardId = cardId,
			cost = cost
		})
	})

	if not success or code ~= 200 then return false, body end
	return true, body.data :: CardListing
end

function Service:ListPack(player, packName, cost)
	local profile = GetProfile(player)
	if not profile then return false end

	local success, code, body = Request({
		path = "/marketplace/list",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			type = "pack",
			userId = `{player.UserId}`,
			username = player.Name,
			packName = packName,
			cost = cost
		})
	})

	if not success or code ~= 200 then return false, body end
	self:ReconcileFromBackend(profile, nil, player)
	return true, body.data :: PackListing
end

function Service:UnlistCard(player, cardId)
	local profile = GetProfile(player)
	if not profile then return false end

	local success, code, body = Request({
		path = "/marketplace/unlist",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			type = "card",
			userId = `{player.UserId}`,
			cardId = cardId
		})
	})

	if not success or code ~= 200 then return false, body end
	return true, body.data
end

function Service:UnlistPack(player, listingId)
	local profile = GetProfile(player)
	if not profile then return false end

	local success, code, body = Request({
		path = "/marketplace/unlist",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			type = "pack",
			userId = `{player.UserId}`,
			listingId = listingId
		})
	})

	if not success or code ~= 200 then return false, body end
	self:ReconcileFromBackend(profile, nil, player)
	return true, body.data
end

function Service:GetUserListings(userId: number | string): (boolean, { MarketplaceListing }?, number?)
	local success, code, body = Request({
		path = `/marketplace/listings/{userId}`,
		method = "GET"
	})

	if not success or code ~= 200 then return false, nil, nil end
	return true, body.data.listings :: { MarketplaceListing }, body.data.count
end

function Service:GetMarketplaceHistory(): (boolean, MarketplaceHistory?)
	local success, code, body = Request({
		path = "/marketplace/history",
		method = "GET"
	})

	if not success or code ~= 200 then return false, nil end
	return true, body.data :: MarketplaceHistory
end

function Service:BuyCard(player, cardId, expectedCost)
	local profile = GetProfile(player)
	if not profile then return false end

	local success, code, body = Request({
		path = "/marketplace/buy",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			type = "card",
			buyerId = `{player.UserId}`,
			cardId = cardId,
			expectedCost = expectedCost
		})
	})

	if not success or code ~= 200 then return false, body end
	self:ReconcileFromBackend(profile, nil, player)
	return true, body.data
end

function Service:BuyPack(player, listingId, expectedCost)
	local profile = GetProfile(player)
	if not profile then return false end

	local success, code, body = Request({
		path = "/marketplace/buy",
		method = "POST",
		headers = { ["Content-Type"] = "application/json" },
		body = HttpService:JSONEncode({
			type = "pack",
			buyerId = `{player.UserId}`,
			listingId = listingId,
			expectedCost = expectedCost
		})
	})

	if not success or code ~= 200 then return false, body end
	self:ReconcileFromBackend(profile, nil, player)
	return true, body.data
end

function Service:Transfer(transfers, indempotencyKey)
	local normalizedTransfers = {}

	for _, transfer in ipairs(transfers) do
		local fromUserId = typeof(transfer.from) == "number" and transfer.from or transfer.from.UserId
		local toUserId = typeof(transfer.to) == "number" and transfer.to or transfer.to.UserId

		local normalizedCards = nil
		if transfer.cards and #transfer.cards > 0 then
			normalizedCards = {}
			for _, card in ipairs(transfer.cards) do
				if typeof(card) == "string" then
					table.insert(normalizedCards, { cardId = card })
				else
					table.insert(normalizedCards, { cardId = card.cardId })
				end
			end
		end

		local normalizedPacks = nil
		if transfer.packs then
			normalizedPacks = {}
			for packName, quantity in pairs(transfer.packs) do
				table.insert(normalizedPacks, { packName = packName, quantity = quantity })
			end
			if #normalizedPacks == 0 then normalizedPacks = nil end
		end

		local t = {
			fromUserId = `{fromUserId}`,
			toUserId = `{toUserId}`,
		}

		if normalizedCards then t.cards = normalizedCards end
		if normalizedPacks then t.packs = normalizedPacks end

		table.insert(normalizedTransfers, t)
	end

	local success, code, body = Request({
		path = "/transfer",
		method = "POST",
		headers = { ["Content-Type"] = "application/json", ["Idempotency-Key"] = indempotencyKey },
		body = HttpService:JSONEncode({ transfers = normalizedTransfers })
	})

	if (not success or code ~= 200) then return false end

	if body and body.data then
		for userId, inventory in pairs(body.data) do
			local player = Players:GetPlayerByUserId(tonumber(userId))
			if player then
				local profile = GetProfile(player)
				if profile then
					self:ReconcileFromBackend(profile, inventory, player)
				end
			end
		end
	end

	return true
end

return Service
