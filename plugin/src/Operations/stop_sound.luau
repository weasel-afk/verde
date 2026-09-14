local SoundPlayer = require(script.Parent.Parent.Shared.SoundPlayer)

return function(_operation)
	return SoundPlayer.stop()
end
