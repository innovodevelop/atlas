import { memo } from 'react';
import { Plane, Calendar, MapPin, Luggage, ChevronRight } from 'lucide-react';
import { DashboardCard } from './DashboardCard';
import { motion } from 'framer-motion';

interface TravelCardProps {
  isFocused?: boolean;
  streamingData?: any[];
  onExpand?: () => void;
}

const upcomingTrip = {
  destination: 'Paris, France',
  flag: '🇫🇷',
  dates: 'Dec 20 - Dec 27, 2024',
  daysUntil: 6,
  flight: {
    airline: 'Air France',
    flightNumber: 'AF 083',
    departure: '10:30 AM',
    arrival: '7:45 PM +1',
    status: 'On Time',
    class: 'Business'
  },
  hotel: {
    name: 'Hotel Le Marais',
    checkIn: 'Dec 20, 3:00 PM',
    nights: 7
  },
  packingProgress: 75,
  activities: ['Eiffel Tower', 'Louvre Museum', 'Seine Cruise'],
};

const TravelCardComponent = ({ isFocused, onExpand }: TravelCardProps) => {
  return (
    <DashboardCard
      glowColor="rgba(168, 85, 247, 0.15)"
      onClick={onExpand}
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-violet-500/20 to-purple-500/20 border border-violet-500/20">
              <Plane className="w-5 h-5 text-violet-400" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Upcoming Trip</h3>
              <p className="text-xs text-muted-foreground">{upcomingTrip.daysUntil} days away</p>
            </div>
          </div>
          <motion.div
            animate={{ scale: [1, 1.1, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="text-3xl"
          >
            {upcomingTrip.flag}
          </motion.div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Destination */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <h4 className="text-xl font-semibold text-foreground">{upcomingTrip.destination}</h4>
            <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-1">
              <Calendar className="w-3.5 h-3.5" />
              {upcomingTrip.dates}
            </p>
          </div>
          
          {/* Countdown */}
          <div className="flex flex-col items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-500/20 border border-violet-500/20">
            <span className="text-2xl font-bold text-foreground">{upcomingTrip.daysUntil}</span>
            <span className="text-[10px] text-violet-400 uppercase tracking-wider">Days</span>
          </div>
        </div>
        
        {/* Flight details */}
        <div className="p-3 rounded-xl bg-card/50 border border-border/50">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Plane className="w-4 h-4 text-violet-400" />
              <span className="text-sm font-medium text-foreground">{upcomingTrip.flight.airline}</span>
              <span className="text-xs text-muted-foreground">{upcomingTrip.flight.flightNumber}</span>
            </div>
            <span className="px-2 py-0.5 text-[10px] font-medium text-emerald-400 bg-emerald-500/10 rounded-full border border-emerald-500/20">
              {upcomingTrip.flight.status}
            </span>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">{upcomingTrip.flight.departure}</p>
              <p className="text-xs text-muted-foreground">SFO</p>
            </div>
            
            <div className="flex-1 mx-4 relative">
              <div className="h-px bg-gradient-to-r from-violet-500/50 via-violet-500 to-violet-500/50" />
              <motion.div
                className="absolute top-1/2 -translate-y-1/2"
                animate={{ left: ['10%', '80%'] }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              >
                <Plane className="w-4 h-4 text-violet-400 rotate-90" />
              </motion.div>
            </div>
            
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">{upcomingTrip.flight.arrival}</p>
              <p className="text-xs text-muted-foreground">CDG</p>
            </div>
          </div>
        </div>
        
        {/* Hotel */}
        <div className="flex items-center gap-3 p-3 rounded-xl bg-card/50 border border-border/50">
          <MapPin className="w-5 h-5 text-violet-400" />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">{upcomingTrip.hotel.name}</p>
            <p className="text-xs text-muted-foreground">{upcomingTrip.hotel.nights} nights · {upcomingTrip.hotel.checkIn}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </div>
        
        {/* Packing progress */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Luggage className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Packing Progress</span>
            </div>
            <span className="text-sm font-medium text-violet-400">{upcomingTrip.packingProgress}%</span>
          </div>
          <div className="h-2 bg-muted/20 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-violet-500 to-purple-500 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${upcomingTrip.packingProgress}%` }}
              transition={{ duration: 1, delay: 0.3 }}
            />
          </div>
        </div>
        
        {/* Activities */}
        <div className="flex flex-wrap gap-2">
          {upcomingTrip.activities.map((activity, i) => (
            <span 
              key={i}
              className="px-2.5 py-1 text-xs text-violet-300 bg-violet-500/10 rounded-full border border-violet-500/20"
            >
              {activity}
            </span>
          ))}
        </div>
      </div>
    </DashboardCard>
  );
};

export const TravelCard = memo(TravelCardComponent);
