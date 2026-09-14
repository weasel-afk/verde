local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
local Decoder = require(script.Parent.Parent.Tree.Decoder)

return function(operation)
	local actions = operation.actions

	if typeof(actions) ~= "table" then
		return false, "actions must be an array of tree actions"
	end

	-- One recording for the whole batch: a single undo step per applied
	-- game.json save. Per-action failures are collected, not thrown, so
	-- the recording always commits with whatever could be applied.
	local success, errorMessage, result = ChangeHistoryHelper.RecordBatch(
		"ApplyTreeActions",
		"Apply game.json changes",
		function()
			return Decoder.apply(actions)
		end
	)

	if not success then
		return false, errorMessage
	end

	return result
end
