local SoundPlayer = require(script.Parent.Parent.Shared.SoundPlayer)

return function(operation)
	local timePosition = operation.timePosition

	if typeof(timePosition) ~= "number" then
		return false, "timePosition must be a number"
	end

	return SoundPlayer.setTimePosition(timePosition)
end
