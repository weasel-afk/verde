local Services = require(script.Parent.Shared.Services)
local isValidInstance = require(script.Parent.Utils.isValidInstance)

local BUILD_YIELD_EVERY = 2000
local SEARCH_YIELD_SECONDS = 0.008
local MAX_SEARCH_MATCHES = 500

type SearchRecord = {
	id: string,
	instance: Instance,
	parentId: string?,
	nameLower: string,
	classLower: string,
	pathLower: string,
	searchTextLower: string,
	removed: boolean?,
	nameConnection: RBXScriptConnection?,
	ancestryConnection: RBXScriptConnection?,
}

type PartialCallback = ({ Instance }, boolean) -> ()
type CancelCallback = () -> boolean

local SearchIndex = {}

local records: { SearchRecord } = {}
local recordsById: { [string]: SearchRecord } = {}
local rebuildToken = 0
local building = false

local function parentDebugId(instance: Instance): string?
	local parent = instance.Parent
	if parent and parent ~= game then
		return parent:GetDebugId(0)
	end
	return nil
end

local function disconnectRecord(record: SearchRecord)
	if record.nameConnection then
		record.nameConnection:Disconnect()
		record.nameConnection = nil
	end
	if record.ancestryConnection then
		record.ancestryConnection:Disconnect()
		record.ancestryConnection = nil
	end
end

local function refreshRecord(record: SearchRecord)
	local instance = record.instance
	local parentId = parentDebugId(instance)
	local parentRecord = if parentId then recordsById[parentId] else nil
	local nameLower = string.lower(instance.Name)
	local classLower = string.lower(instance.ClassName)
	local pathLower = if parentRecord and not parentRecord.removed
		then parentRecord.pathLower .. "." .. nameLower
		else nameLower

	record.parentId = parentId
	record.nameLower = nameLower
	record.classLower = classLower
	record.pathLower = pathLower
	record.searchTextLower = pathLower .. "\n" .. classLower
end

local removeSubtree
local refreshSubtree

local function addInstance(instance: Instance, assumeValid: boolean?): SearchRecord?
	if not assumeValid and not isValidInstance(instance) then
		return nil
	end

	local id = instance:GetDebugId(0)
	local existing = recordsById[id]
	if existing then
		existing.removed = false
		refreshRecord(existing)
		return existing
	end

	local record: SearchRecord = {
		id = id,
		instance = instance,
		parentId = nil,
		nameLower = "",
		classLower = "",
		pathLower = "",
		searchTextLower = "",
	}

	recordsById[id] = record
	table.insert(records, record)
	refreshRecord(record)

	record.nameConnection = instance:GetPropertyChangedSignal("Name"):Connect(function()
		refreshSubtree(instance)
	end)

	record.ancestryConnection = instance.AncestryChanged:Connect(function()
		if instance.Parent == nil or not isValidInstance(instance) then
			removeSubtree(instance)
			return
		end
		refreshSubtree(instance)
	end)

	return record
end

local function addSubtreeInternal(root: Instance, shouldCancel: CancelCallback?, assumeValid: boolean?): boolean
	local stack: { Instance } = { root }
	local visited = 0

	while #stack > 0 do
		if shouldCancel and shouldCancel() then
			return false
		end

		local instance = stack[#stack]
		stack[#stack] = nil

		if assumeValid or isValidInstance(instance) then
			addInstance(instance, true)
			local children = instance:GetChildren()
			for i = #children, 1, -1 do
				stack[#stack + 1] = children[i]
			end
		end

		visited += 1
		if visited % BUILD_YIELD_EVERY == 0 then
			task.wait()
		end
	end

	return true
end

function refreshSubtree(root: Instance)
	local stack: { Instance } = { root }
	while #stack > 0 do
		local instance = stack[#stack]
		stack[#stack] = nil

		local record = recordsById[instance:GetDebugId(0)]
		if record and not record.removed then
			refreshRecord(record)
		end

		for _, child in instance:GetChildren() do
			if recordsById[child:GetDebugId(0)] then
				stack[#stack + 1] = child
			end
		end
	end
end

function removeSubtree(root: Instance)
	local stack: { Instance } = { root }
	while #stack > 0 do
		local instance = stack[#stack]
		stack[#stack] = nil

		local id = instance:GetDebugId(0)
		local record = recordsById[id]
		if record then
			record.removed = true
			disconnectRecord(record)
			recordsById[id] = nil
		end

		for _, child in instance:GetChildren() do
			stack[#stack + 1] = child
		end
	end
end

local function clearRecords()
	for _, record in records do
		disconnectRecord(record)
		record.removed = true
	end
	table.clear(records)
	table.clear(recordsById)
end

function SearchIndex.clear()
	rebuildToken += 1
	building = false
	clearRecords()
end

function SearchIndex.beginBuild(): number
	rebuildToken += 1
	local token = rebuildToken
	building = true
	clearRecords()
	return token
end

function SearchIndex.addVisitedInstance(token: number, instance: Instance): boolean
	if token ~= rebuildToken or not building then
		return false
	end
	addInstance(instance, true)
	return true
end

function SearchIndex.finishBuild(token: number): boolean
	if token ~= rebuildToken then
		return false
	end
	building = false
	return true
end

function SearchIndex.cancelBuild(token: number)
	if token ~= rebuildToken then
		return
	end
	rebuildToken += 1
	building = false
	clearRecords()
end

function SearchIndex.rebuildAsync()
	local token = SearchIndex.beginBuild()
	task.spawn(function()
		if token ~= rebuildToken then
			return
		end
		for _, serviceName in Services do
			if token ~= rebuildToken then
				return
			end
			local service = game:GetService(serviceName)
			local completed = addSubtreeInternal(service, function()
				return token ~= rebuildToken
			end, true)
			if not completed then
				return
			end
		end
		SearchIndex.finishBuild(token)
	end)
end

function SearchIndex.isReady(): boolean
	return not building and #records > 0
end

function SearchIndex.isBuilding(): boolean
	return building
end

function SearchIndex.addSubtree(root: Instance)
	addSubtreeInternal(root, nil, true)
end

function SearchIndex.removeSubtree(root: Instance)
	removeSubtree(root)
end

local function tokenize(lowercaseQuery: string): { string }
	local tokens: { string } = {}
	for token in string.gmatch(lowercaseQuery, "[^%s%.]+") do
		table.insert(tokens, token)
	end
	return tokens
end

local function matches(record: SearchRecord, tokens: { string }): boolean
	if record.removed or record.instance.Parent == nil then
		return false
	end

	for _, token in tokens do
		if string.find(record.searchTextLower, token, 1, true) == nil then
			return false
		end
	end

	return true
end

function SearchIndex.search(
	lowercaseQuery: string,
	shouldCancel: CancelCallback?,
	onFirstResult: PartialCallback?
): ({ Instance }, boolean, boolean)
	local tokens = tokenize(lowercaseQuery)
	local matched: { Instance } = {}
	local truncated = false
	local firstResultSent = false
	local lastYieldAt = os.clock()

	if #tokens == 0 then
		return matched, false, false
	end

	local recordCount = #records
	for index = 1, recordCount do
		local record = records[index]
		if not record then
			continue
		end
		if shouldCancel and shouldCancel() then
			return matched, truncated, true
		end

		if matches(record, tokens) then
			matched[#matched + 1] = record.instance
			if not firstResultSent and onFirstResult then
				firstResultSent = true
				onFirstResult({ record.instance }, false)
			end
			if #matched >= MAX_SEARCH_MATCHES then
				truncated = true
				break
			end
		end

		if os.clock() - lastYieldAt >= SEARCH_YIELD_SECONDS then
			task.wait()
			lastYieldAt = os.clock()
			if shouldCancel and shouldCancel() then
				return matched, truncated, true
			end
		end
	end

	return matched, truncated, false
end

return SearchIndex
