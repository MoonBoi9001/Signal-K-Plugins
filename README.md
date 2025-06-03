# Signal K Plugins

A collection of specialized Signal K plugins off-grid electrical systems.

## Available Plugins

### [Smart Grid Controller](./smart-grid-controller/)
Intelligent AC grid management plugin for Victron MultiPlus II systems. 

**Key Features:**
- Automated grid connection based on load, battery state, and time schedules
- Multi-layer battery protection with emergency cutoffs
- Load-based switching for high-power equipment
- Scheduled charging during off-peak hours
- Comprehensive hysteresis and timing controls

**Use Cases:**
- Off-grid homes with backup grid connection
- Marine installations with shore power management  
- RV/motorhome electrical systems
- Any system requiring intelligent grid/battery switching

## Installation

Each plugin can be installed independently via the Signal K App Store or by manually copying the plugin directory to your Signal K plugins folder.

### Manual Installation
```bash
cd ~/.signalk/node_modules/
git clone https://github.com/your-username/Signal-K-Plugins.git
# Or copy individual plugin directories
```

## Requirements

- Signal K server (v1.0+)
- Victron Energy equipment with Cerbo GX
- VenusOS "Large" firmware
- Appropriate external contactors/relays for switching

## Development

Each plugin follows Signal K plugin conventions:
- `package.json` with proper Signal K metadata
- `index.js` as main entry point
- Self-contained with no shared dependencies
- Comprehensive documentation and safety considerations

## Safety Notice

These plugins control high-voltage AC electrical systems and battery management. Always:
- **CRITICAL**: Configure plugins for your specific battery type and system voltage
- Verify settings for your configuration, blindly using these settings could cause trouble!
- Test thoroughly in safe conditions
- Ensure proper electrical safety procedures
- Use appropriately rated contactors and protection devices
- Monitor system behavior during initial deployment
- Have qualified electrical support when needed

### Battery Configuration Requirements
Plugins may include battery-specific voltage thresholds that MUST be configured correctly:
- **Wrong voltage settings can damage batteries or create safety hazards**
- **Default settings may not match your battery chemistry or cell count**
- **Always verify configuration through Signal K admin panel before enabling**
- **Test with monitoring and safety equipment in place**

## Contributing

Contributions welcome! Please ensure:
- Proper Signal K plugin structure
- Comprehensive documentation
- Safety considerations addressed
- Testing procedures included

## License

MIT License - see individual plugin directories for details. 