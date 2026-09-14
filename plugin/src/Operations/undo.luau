local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)

return function(_payload)
	local canUndo, _operationName = ChangeHistoryHelper.GetCanUndo()
	if not canUndo then
		return false, "Nothing to undo"
	end

	ChangeHistoryHelper.Undo()
	return true
end