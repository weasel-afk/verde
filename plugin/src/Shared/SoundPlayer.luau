local SoundPlayer = {}

local widget: DockWidgetPluginGui? = nil
local currentSound: Sound? = nil
local currentSourceId: string? = nil

function SoundPlayer.Init(pluginObject: Plugin)
	if widget then
		return
	end

	local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, true, 1, 1, 1, 1)

	widget = pluginObject:CreateDockWidgetPluginGuiAsync("VerdeSoundPlayer", widgetInfo)
	widget.Title = "Verde Sound Player"
	widget.Enabled = false
end

function SoundPlayer.play(sourceSound: Sound, sourceId: string): (boolean, string?)
	if not widget then
		return false, "SoundPlayer not initialized"
	end
	SoundPlayer.stop()

	local clonedSound = sourceSound:Clone()
	clonedSound.Parent = widget
	clonedSound.Name = "VerdeSoundPreview"

	currentSound = clonedSound
	currentSourceId = sourceId

	local success, err = pcall(function()
		clonedSound:Play()
	end)

	if not success then
		clonedSound:Destroy()
		currentSound = nil
		currentSourceId = nil
		return false, tostring(err)
	end

	clonedSound.Ended:Once(function()
		if currentSound == clonedSound then
			clonedSound:Destroy()
			currentSound = nil
			currentSourceId = nil
		end
	end)

	return true
end

function SoundPlayer.stop(): (boolean, string?)
	if currentSound then
		local success, err = pcall(function()
			currentSound:Stop()
			currentSound:Destroy()
		end)

		currentSound = nil
		currentSourceId = nil

		if not success then
			return false, tostring(err)
		end
	end

	return true
end

function SoundPlayer.setTimePosition(timePosition: number): (boolean, string?)
	if not currentSound then
		return false, "no sound currently playing"
	end

	local success, err = pcall(function()
		currentSound.TimePosition = math.max(0, timePosition)
	end)

	if not success then
		return false, tostring(err)
	end

	return true
end

function SoundPlayer.getCurrentInfo(): { playing: boolean, timePosition: number, timeLength: number, sourceId: string? }
	if currentSound and currentSound.Playing then
		return {
			playing = true,
			timePosition = currentSound.TimePosition,
			timeLength = currentSound.TimeLength,
			sourceId = currentSourceId,
		}
	end

	return {
		playing = false,
		timePosition = 0,
		timeLength = 0,
		sourceId = nil,
	}
end

function SoundPlayer.isPlaying(sourceId: string): boolean
	return currentSourceId == sourceId and currentSound ~= nil and currentSound.Playing
end

function SoundPlayer.cleanup()
	SoundPlayer.stop()

	if widget then
		widget:Destroy()
		widget = nil
	end
end

return SoundPlayer
