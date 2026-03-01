import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import StaffHome from './pages/StaffHome';
import Simulation3D from './pages/Simulation3D';

function App() {
  return (
    <Router>
      <div className="App">
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/staff" element={<StaffHome />} />
          <Route path="/sim-3d" element={<Simulation3D />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
