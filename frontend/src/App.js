import React from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, ProtectedRoute } from "@/lib/auth";
import AppLayout from "@/components/AppLayout";
import Login from "@/pages/Login";
import AuthCallback from "@/pages/AuthCallback";
import Dashboard from "@/pages/Dashboard";
import ItineraryBuilder from "@/pages/ItineraryBuilder";
import Experiences from "@/pages/Experiences";
import Providers from "@/pages/Providers";
import Hotels from "@/pages/Hotels";
import AITrainer from "@/pages/AITrainer";
import AIGenerate from "@/pages/AIGenerate";
import AdminUsers from "@/pages/AdminUsers";
import PublicPayment from "@/pages/PublicPayment";
import PublicExtraPayment from "@/pages/PublicExtraPayment";
import TripView from "@/pages/TripView";
import "@/App.css";

function HashRouter() {
  const location = useLocation();
  if (location.hash?.includes("session_id=")) return <AuthCallback />;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/pay/extra/:token" element={<PublicExtraPayment />} />
      <Route path="/pay/:token" element={<PublicPayment />} />
      <Route path="/trip/:token" element={<TripView />} />
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/itineraries/:id" element={<ItineraryBuilder />} />
        <Route path="/experiences" element={<Experiences />} />
        <Route path="/providers" element={<Providers />} />
        <Route path="/hotels" element={<Hotels />} />
        <Route path="/ai/trainer" element={<AITrainer />} />
        <Route path="/ai/generate" element={<AIGenerate />} />
        <Route path="/admin/users" element={<ProtectedRoute adminOnly><AdminUsers /></ProtectedRoute>} />
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <AuthProvider>
          <HashRouter />
          <Toaster position="bottom-right" richColors closeButton />
        </AuthProvider>
      </BrowserRouter>
    </div>
  );
}
